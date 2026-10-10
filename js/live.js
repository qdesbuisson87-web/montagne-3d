// Live data, fetched every time the app opens: Météo-France forecasts (via Open-Meteo),
// the latest Sentinel-2 pass and the latest clear one (Microsoft Planetary Computer), snow by altitude.
import { lonLatToMerc, RE } from './geo.js?v=202610101130';
import { SITE } from './sites.js?v=202610101130';
import { timedFetch } from './net.js?v=202610101130';

export const SPOTS = SITE.spots; // top, peak2, mid, valley
// pressure levels (hPa) of the cloud profile: ≈ 1 500, 2 000, 3 000, 4 200, 5 600, 7 200 and 9 200 m
export const CLOUD_LEVELS = [850, 800, 700, 600, 500, 400, 300];
// cloud profile of one hour: [{ alt (m), cover (0–1) }] from low to high, or null when the model gave nothing
export function cloudProfile(extra, hourIso) {
  const h = extra?.hourly; if (!h) return null;
  const k = h.time.findIndex(t => t.slice(0, 13) === hourIso.slice(0, 13)); if (k < 0) return null;
  const out = CLOUD_LEVELS.map(p => ({ alt: h[`geopotential_height_${p}hPa`]?.[k], cover: h[`cloud_cover_${p}hPa`]?.[k] }))
    .filter(l => l.alt != null && l.cover != null).map(l => ({ alt: l.alt, cover: l.cover / 100 }));
  return out.length >= 3 ? out.sort((a, b) => a.alt - b.alt) : null;
}
const qs = o => new URLSearchParams(o).toString();
async function json(url, opts) { const r = await timedFetch(url, opts, 20000); if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`); return r.json(); }

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
  // freezing level, wind aloft and the cloud cover at each pressure level (with the level's altitude) come from
  // the global models (best match): the 3D clouds are placed at the altitudes the model gives, hour by hour
  const levels = CLOUD_LEVELS.flatMap(p => [`cloud_cover_${p}hPa`, `geopotential_height_${p}hPa`]).join(',');
  out.extra = await json('https://api.open-meteo.com/v1/forecast?' + qs({
    latitude: SPOTS.mid.lat, longitude: SPOTS.mid.lon, elevation: SPOTS.mid.alt, timezone: 'Europe/Paris', forecast_days: 3,
    hourly: `freezing_level_height,wind_speed_700hPa,wind_direction_700hPa,geopotential_height_700hPa,${levels}`
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

// forecast at several points at once (along an itinerary), each at its own altitude: Météo-France models, hour by
// hour for 3 days. points: [{ lat, lon, alt }] → [{ time, temperature_2m, precipitation, … }] in the same order
export async function routeForecast(points) {
  const d = await json('https://api.open-meteo.com/v1/forecast?' + qs({
    latitude: points.map(p => p.lat.toFixed(4)).join(','), longitude: points.map(p => p.lon.toFixed(4)).join(','),
    elevation: points.map(p => Math.round(p.alt)).join(','), timezone: 'Europe/Paris', forecast_days: 3, models: 'meteofrance_seamless',
    hourly: 'temperature_2m,precipitation,snowfall,weather_code,wind_speed_10m,wind_gusts_10m'
  }));
  return (Array.isArray(d) ? d : [d]).map(x => x.hourly);
}

// ----- weather radar (RainViewer: the national radars, mosaicked every 10 minutes, the last 2 hours) -----
export async function radarFrames() {
  const d = await json('https://api.rainviewer.com/public/weather-maps.json');
  return (d.radar?.past ?? []).map(f => ({ time: new Date(f.time * 1000), path: d.host + f.path }));
}

// ----- Sentinel-2 -----
const PC = 'https://planetarycomputer.microsoft.com/api';
// core of the massif, web-mercator metres
const CORE = [...lonLatToMerc(SITE.core[0], SITE.core[1]), ...lonLatToMerc(SITE.core[2], SITE.core[3])];
const bboxPng = (item, asset, w, h) => `${PC}/data/v1/item/bbox/${CORE.join(',')}/${w}x${h}.png?` + qs({ collection: 'sentinel-2-l2a', item, assets: asset, nodata: 0, coord_crs: 'epsg:3857', dst_crs: 'epsg:3857', resampling: 'nearest' });

async function decode(url) {
  const r = await timedFetch(url, {}, 30000); if (!r.ok) throw new Error(r.status);
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

// Snow film: the Sentinel-2 passes of the last `days` days over the massif, on the grid square that covers it,
// with less than `maxCloud` of clouds on that square (Copernicus' own figure for the whole 110 km square: the
// massif itself may still be clouded on some dates, the scene classification then masks those clouds).
export async function sentinelYear(days = 365, maxCloud = 30) {
  const now = new Date(), from = new Date(now - days * 864e5), c = SITE.core;
  const res = await json(`${PC}/stac/v1/search?` + qs({ collections: 'sentinel-2-l2a', bbox: c.join(','), datetime: `${from.toISOString()}/${now.toISOString()}`, sortby: '-datetime', limit: 1000 }));
  const covers = f => f.bbox && f.bbox[0] <= c[0] && f.bbox[1] <= c[1] && f.bbox[2] >= c[2] && f.bbox[3] >= c[3];
  const tile = res.features.find(covers)?.properties['s2:mgrs_tile'];
  const seen = new Set();
  return res.features
    .filter(f => f.properties['s2:mgrs_tile'] === tile && (f.properties['eo:cloud_cover'] ?? 100) < maxCloud)
    .map(f => ({ id: f.id, bbox: f.bbox, footprint: f.geometry, date: new Date(f.properties.datetime), cloudTile: f.properties['eo:cloud_cover'] }))
    .filter(e => { const d = e.date.toISOString().slice(0, 10); if (seen.has(d)) return false; seen.add(d); return true; }) // one per day
    .sort((a, b) => a.date - b.date);
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

// Position and lit fraction of the Moon (low-precision lunar theory, as in SunCalc: about 0.2° on the sky),
// same conventions as sunPosition (azimuth from north, clockwise). illum: 0 new moon … 1 full moon.
export function moonPosition(date, lat, lon) {
  const rad = Math.PI / 180, d = date / 864e5 - 10957.5, e = 23.4397 * rad;
  const L = (218.316 + 13.176396 * d) * rad, M = (134.963 + 13.064993 * d) * rad, F = (93.272 + 13.22935 * d) * rad;
  const l = L + 6.289 * rad * Math.sin(M), b = 5.128 * rad * Math.sin(F), dist = 385001 - 20905 * Math.cos(M); // km
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, H = (gmst * 15 + lon) * rad - ra, phi = lat * rad;
  let el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  el += 0.0002967 / Math.tan(el + 0.00312536 / (el + 0.08901179)); // refraction near the horizon
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  // lit fraction from the Sun–Earth–Moon angle
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const Ls = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const raS = Math.atan2(Math.cos(e) * Math.sin(Ls), Math.cos(Ls)), decS = Math.asin(Math.sin(e) * Math.sin(Ls)), sdist = 149598000;
  const psi = Math.acos(Math.sin(decS) * Math.sin(dec) + Math.cos(decS) * Math.cos(dec) * Math.cos(raS - ra));
  const inc = Math.atan2(sdist * Math.sin(psi), dist - sdist * Math.cos(psi));
  return { az: (az + 2 * Math.PI) % (2 * Math.PI), el, illum: (1 + Math.cos(inc)) / 2 };
}

// Sunset (upper limb at the horizon, refraction included: −0.833°) and end of civil twilight (−6°) on the day
// of `date` at a place, as Dates (null when the sun does not cross that height that day). Found by stepping
// through the afternoon, then halving the step (to the minute).
export function sunTimes(date, lat, lon) {
  const noon = new Date(date); noon.setHours(12, 0, 0, 0);
  const when = h0 => {
    const el = t => sunPosition(new Date(t), lat, lon).el * 180 / Math.PI - h0;
    let a = +noon, b = a; if (el(a) < 0) return null;
    for (let i = 0; i < 48; i++) { b = a + 15 * 60e3; if (el(b) < 0) break; a = b; }
    if (el(b) >= 0) return null;
    while (b - a > 60e3) { const m = (a + b) / 2; if (el(m) >= 0) a = m; else b = m; }
    return new Date(b);
  };
  return { sunset: when(-0.833), dusk: when(-6) };
}
