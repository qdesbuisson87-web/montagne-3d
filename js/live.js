// Live data, fetched every time the app opens: Météo-France forecasts (via Open-Meteo),
// the latest Sentinel-2 pass and the latest clear one (Microsoft Planetary Computer), snow by altitude.
import { lonLatToMerc, RE } from './geo.js?v=202609292047';
import { SITE } from './sites.js?v=202609292047';

export const SPOTS = SITE.spots; // top, peak2, mid, valley
const qs = o => new URLSearchParams(o).toString();
async function json(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`); return r.json(); }

export async function fetchWeather() {
  const common = { timezone: 'Europe/Paris', forecast_days: 4, models: 'meteofrance_seamless' };
  const cur = 'temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,cloud_cover_low,cloud_cover_mid,weather_code,snowfall,precipitation,is_day';
  const out = {};
  await Promise.all(Object.entries(SPOTS).map(async ([k, s]) => {
    out[k] = await json('https://api.open-meteo.com/v1/forecast?' + qs({
      ...common, latitude: s.lat, longitude: s.lon, elevation: s.alt, current: cur,
      hourly: 'temperature_2m,snowfall,precipitation,cloud_cover,cloud_cover_low,wind_gusts_10m,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,weather_code,wind_gusts_10m_max,sunrise,sunset'
    }));
  }));
  // freezing level and modelled snow depth come from the global models (best match)
  out.extra = await json('https://api.open-meteo.com/v1/forecast?' + qs({
    latitude: SPOTS.mid.lat, longitude: SPOTS.mid.lon, elevation: SPOTS.mid.alt, timezone: 'Europe/Paris', forecast_days: 3,
    hourly: 'freezing_level_height,snow_depth'
  })).catch(() => null);
  out.fetchedAt = new Date();
  return out;
}

// Forecast at an exact point and altitude: Météo-France recomputes temperature, so rain/snow split, for that height
export async function pointForecast(lat, lon, alt) {
  const d = await json('https://api.open-meteo.com/v1/forecast?' + qs({
    latitude: lat, longitude: lon, elevation: Math.round(alt), timezone: 'Europe/Paris', forecast_days: 4, models: 'meteofrance_seamless',
    current: 'temperature_2m,precipitation,rain,snowfall,weather_code,wind_speed_10m,wind_gusts_10m',
    hourly: 'temperature_2m,precipitation,rain,snowfall,weather_code'
  }));
  const h = d.hourly, now = d.current.time.slice(0, 13), k0 = Math.max(0, h.time.findIndex(t => t.slice(0, 13) === now));
  const sum = (arr, n) => arr.slice(k0, k0 + n).reduce((a, v) => a + (v || 0), 0);
  let firstSnow = null; for (let k = k0; k < h.time.length; k++) if ((h.snowfall[k] || 0) >= 0.2) { firstSnow = h.time[k]; break; }
  return { current: d.current, snow24: sum(h.snowfall, 24), snow72: sum(h.snowfall, 72), rain24: sum(h.rain, 24), rain72: sum(h.rain, 72),
    tmin: Math.min(...h.temperature_2m.slice(k0, k0 + 24)), tmax: Math.max(...h.temperature_2m.slice(k0, k0 + 24)), firstSnow, hourly: h, k0 };
}

// ----- Sentinel-2 -----
const PC = 'https://planetarycomputer.microsoft.com/api';
// core of the massif, web-mercator metres
const CORE = [...lonLatToMerc(SITE.core[0], SITE.core[1]), ...lonLatToMerc(SITE.core[2], SITE.core[3])];
const bboxPng = (item, asset, w, h) => `${PC}/data/v1/item/bbox/${CORE.join(',')}/${w}x${h}.png?` + qs({ collection: 'sentinel-2-l2a', item, assets: asset, nodata: 0, coord_crs: 'epsg:3857', dst_crs: 'epsg:3857', resampling: 'nearest' });

async function decode(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(r.status);
  const bm = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
  const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(bm, 0, 0);
  return { w: bm.width, h: bm.height, d: c.getImageData(0, 0, bm.width, bm.height).data };
}
const sclStats = img => {
  let valid = 0, cloud = 0, snow = 0;
  for (let k = 0; k < img.d.length; k += 4) { const v = img.d[k], a = img.d[k + 3]; if (!a || !v) continue; valid++; if (v >= 8 && v <= 10) cloud++; if (v === 11) snow++; }
  const n = img.w * img.h; return { validFrac: valid / n, cloud: valid ? cloud / valid : 1, snow: valid ? snow / valid : 0 };
};

export async function findSentinel(onProgress) {
  const now = new Date(), from = new Date(now - 40 * 864e5);
  // plain GET: a JSON POST would need a CORS preflight, which the STAC API refuses
  const c = SITE.core, res = await json(`${PC}/stac/v1/search?` + qs({ collections: 'sentinel-2-l2a', bbox: c.join(','), datetime: `${from.toISOString()}/${now.toISOString()}`, sortby: '-datetime', limit: 80 }));
  // keep the one Sentinel-2 grid square that covers the whole core of the massif
  const covers = f => f.bbox && f.bbox[0] <= c[0] && f.bbox[1] <= c[1] && f.bbox[2] >= c[2] && f.bbox[3] >= c[3];
  const tile = res.features.find(covers)?.properties['s2:mgrs_tile'];
  const feats = res.features.filter(f => f.properties['s2:mgrs_tile'] === tile).sort((a, b) => b.properties.datetime.localeCompare(a.properties.datetime));
  let latest = null, clear = null;
  for (const f of feats) {
    onProgress?.(f.properties.datetime);
    const st = sclStats(await decode(bboxPng(f.id, 'SCL', 224, 256)).catch(() => ({ w: 1, h: 1, d: new Uint8ClampedArray(4) })));
    if (st.validFrac < 0.9) continue;
    const entry = { id: f.id, bbox: f.bbox, footprint: f.geometry, date: new Date(f.properties.datetime), cloud: st.cloud, snow: st.snow };
    if (!latest) latest = entry;
    if (st.cloud < 0.2) { clear = entry; break; }
  }
  if (clear) clear.bands = await snowByAltitude(clear.id).catch(() => null);
  return { latest, clear };
}

// share of snow-covered ground per 100 m band, north- and south-facing slopes (DEM: Terrarium z12)
async function snowByAltitude(item) {
  const W = 448, H = 512, scl = await decode(bboxPng(item, 'SCL', W, H));
  const z = 12, n = 2 ** z, tx0 = Math.floor((CORE[0] + RE) / (2 * RE) * n), tx1 = Math.floor((CORE[2] + RE) / (2 * RE) * n), ty0 = Math.floor((RE - CORE[3]) / (2 * RE) * n), ty1 = Math.floor((RE - CORE[1]) / (2 * RE) * n);
  const tiles = new Map();
  await Promise.all([...Array((tx1 - tx0 + 1) * (ty1 - ty0 + 1)).keys()].map(async k => {
    const x = tx0 + k % (tx1 - tx0 + 1), y = ty0 + Math.floor(k / (tx1 - tx0 + 1));
    tiles.set(`${x}/${y}`, await decode(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`));
  }));
  const dem = (mx, my) => {
    const fx = (mx + RE) / (2 * RE) * n, fy = (RE - my) / (2 * RE) * n, t = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (!t) return NaN; const px = Math.min(255, Math.floor((fx % 1) * 256)), py = Math.min(255, Math.floor((fy % 1) * 256)), q = (py * 256 + px) * 4;
    return t.d[q] * 256 + t.d[q + 1] + t.d[q + 2] / 256 - 32768;
  };
  const E = new Float32Array(W * H), dx = (CORE[2] - CORE[0]) / W, dy = (CORE[3] - CORE[1]) / H;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) E[j * W + i] = dem(CORE[0] + (i + 0.5) * dx, CORE[3] - (j + 0.5) * dy);
  const bands = []; for (let b = 1000; b < 4800; b += 100) bands.push({ alt: b, n: [0, 0], s: [0, 0] });
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const k = j * W + i, v = scl.d[k * 4]; if (!scl.d[k * 4 + 3] || !v || v === 3 || (v >= 8 && v <= 10)) continue;
    const gy = (E[k + W] - E[k - W]) / (2 * dy * 0.696); // + when the ground rises southwards => north-facing
    const b = bands[Math.floor((E[k] - 1000) / 100)]; if (!b) continue;
    const side = gy > 0.15 ? b.n : gy < -0.15 ? b.s : null; if (!side) continue;
    side[1]++; if (v === 11) side[0]++;
  }
  return bands.map(b => ({ alt: b.alt, north: b.n[1] > 150 ? b.n[0] / b.n[1] : null, south: b.s[1] > 150 ? b.s[0] / b.s[1] : null }));
}

// ----- sun position (NOAA approximation), returns azimuth from north (clockwise) and elevation, radians -----
export function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180, d = date / 864e5 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, H = ((gmst * 15 + lon) * rad - ra);
  const phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { az: (az + 2 * Math.PI) % (2 * Math.PI), el };
}
