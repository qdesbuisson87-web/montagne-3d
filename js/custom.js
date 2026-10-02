// A massif anywhere in France, made from official data in a few seconds and kept on the device: the chosen
// point is the origin (its altitude from IGN RGE ALTI), the named summits around come from IGN BD TOPO (with their
// altitudes), the weather is taken at four heights (the point, the highest summit, mid-slope, the lowest inhabited
// place nearby), and the avalanche bulletin's massif is found with the owner's Météo-France key when there is one.
// Read back by sites.js on the next opening (?site=<id>).
import { cachedFetch } from './net.js?v=202610021731';
const STORE = 'midi3d-custom-sites';
const WFS = (layer, cql, [w, s, e, n]) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${layer}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=500`
  + `&CQL_FILTER=${encodeURIComponent(`${cql} AND BBOX(geometrie,${w},${s},${e},${n},'EPSG:4326')`)}`;
const ALTI = pts => `https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${pts.map(p => p[0].toFixed(5)).join('|')}&lat=${pts.map(p => p[1].toFixed(5)).join('|')}&resource=ign_rge_alti_wld&zonly=true`;
// through the app's network queue: waits and asks again when IGN is busy (429), and keeps the answers
const json = async u => { const r = await cachedFetch(u); if (!r.ok) throw new Error(`IGN ${r.status}`); return r.json(); };
const centre = g => { const r = g.type === 'Point' ? [g.coordinates] : g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.coordinates; return [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length]; };
async function altitudes(pts) { const out = []; for (let i = 0; i < pts.length; i += 100) out.push(...(await json(ALTI(pts.slice(i, i + 100)))).elevations.map(v => v > -1000 ? Math.round(v) : null)); return out; }
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

export const customSites = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
export function removeSite(id) { const all = customSites(); delete all[id]; try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { } }

// massif numbers of the avalanche bulletin: Météo-France's list of massifs (polygons), with the owner's key
async function braAt(lon, lat, key) {
  if (!key) return null;
  try {
    const r = await fetch('https://public-api.meteofrance.fr/public/DPBRA/v1/liste-massifs', { headers: { apikey: key } }); if (!r.ok) return null;
    const g = await r.json(), inRing = (ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c; } return c; };
    for (const f of g.features ?? []) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      if (polys.some(p => inRing(p[0]))) return f.properties.code ?? f.properties.id ?? f.properties.massif ?? null;
    }
  } catch { }
  return null;
}

// onStep(text): progress for the screen
export async function makeSite(lon, lat, name, braKey, onStep = () => { }) {
  onStep('Altitude du point…');
  // a named summit's coordinates are often a little off its top: the highest IGN RGE ALTI point within ~150 m
  const grid = []; for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) grid.push([lon + i * 0.00048, lat + j * 0.00034]);
  const ga = await altitudes(grid); let best = -1; ga.forEach((a, k) => { if (a != null && (best < 0 || a > ga[best])) best = k; });
  if (best < 0) throw new Error("pas d'altitude IGN ici (hors de France ?)");
  [lon, lat] = grid[best]; const alt = ga[best];
  const box = [lon - 0.13, lat - 0.09, lon + 0.13, lat + 0.09];
  onStep('Sommets et villages autour (IGN)…');
  const [oro, hab] = await Promise.all([
    json(WFS('BDTOPO_V3:detail_orographique', "nature IN ('Sommet','Pic') AND toponyme IS NOT NULL", box)),
    json(WFS('BDTOPO_V3:zone_d_habitation', "nature='Lieu-dit habité' AND toponyme IS NOT NULL", box))
  ]);
  const peaks = oro.features.map(f => ({ name: f.properties.toponyme, ll: centre(f.geometry) })).filter((p, i, a) => a.findIndex(q => q.name === p.name) === i).slice(0, 120);
  const villages = hab.features.map(f => ({ name: f.properties.toponyme, ll: centre(f.geometry) })).slice(0, 60);
  onStep('Altitudes des sommets et des villages…');
  const pa = await altitudes(peaks.map(p => p.ll)), va = villages.length ? await altitudes(villages.map(v => v.ll)) : [];
  peaks.forEach((p, i) => { p.alt = pa[i]; }); villages.forEach((v, i) => { v.alt = va[i]; });
  // no name given: the nearest named summit within ~1.5 km, else a plain label
  if (!name) { const near = peaks.map(p => ({ p, d: Math.hypot((p.ll[0] - lon) * Math.cos(lat * Math.PI / 180), p.ll[1] - lat) })).sort((a, b) => a.d - b.d)[0]; name = near && near.d < 0.014 ? near.p.name : 'Lieu choisi'; }
  const top = peaks.filter(p => p.alt).sort((a, b) => b.alt - a.alt), valley = villages.filter(v => v.alt).sort((a, b) => a.alt - b.alt)[0];
  const peak2 = top.find(p => Math.hypot(p.ll[0] - lon, p.ll[1] - lat) > 0.005) ?? { name, ll: [lon, lat], alt };
  const low = valley ?? { name: 'Vallée', ll: [lon + 0.05, lat + 0.03], alt: Math.max(400, alt - 1500) };
  const midLL = [(lon + low.ll[0]) / 2, (lat + low.ll[1]) / 2], [midAlt] = await altitudes([midLL]);
  onStep('Bulletin d’avalanche…');
  const bra = await braAt(lon, lat, braKey);
  const id = 'c-' + slug(name || `${lat.toFixed(3)}-${lon.toFixed(3)}`);
  const site = {
    id, name, alt, region: `Lieu ajouté · ${low.name}`, custom: true,
    origin: { lat, lon }, geoidN: 51, bra,
    bounds: [lon - 0.45, lat - 0.3, lon + 0.45, lat + 0.3], core: [lon - 0.085, lat - 0.058, lon + 0.085, lat + 0.058], detail: [lon - 0.014, lat - 0.011, lon + 0.014, lat + 0.011],
    spots: {
      top: { name, lat, lon, alt }, peak2: { name: peak2.name, lat: peak2.ll[1], lon: peak2.ll[0], alt: peak2.alt },
      mid: { name: 'Mi-pente', lat: midLL[1], lon: midLL[0], alt: midAlt ?? Math.round((alt + low.alt) / 2) }, valley: { name: low.name, lat: low.ll[1], lon: low.ll[0], alt: low.alt }
    },
    home: { dy: 80, cam: [-620, 260, -700] }, cable: null,
    places: [{ id: 'top', name, alt, ll: [lat, lon], star: true, dist: 1000 },
      ...top.filter(p => p.name !== name).slice(0, 24).map(p => ({ name: p.name, alt: p.alt, ll: [p.ll[1], p.ll[0]] })),
      { name: low.name, alt: low.alt, ll: [low.ll[1], low.ll[0]] }],
    links: [['https://meteofrance.com/meteo-montagne', 'Météo et bulletins d’avalanche montagne — Météo-France']]
  };
  const all = customSites(); all[id] = site; try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { }
  return site;
}
