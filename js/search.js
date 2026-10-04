// Place search: IGN Géoplateforme gazetteer (summits, refuges, lakes, villages in France) and OpenStreetMap's
// Nominatim for the rest of the Alps, both biased towards what is on screen, then sorted by distance from it:
// a name like "Grand Paradis" exists in many places, the one wanted is almost always the nearest.
// Nominatim's rules (at most one request per second, no search-as-you-type) are met by searching on submit only.
import { timedFetch } from './net.js?v=202610042116';

const first = v => Array.isArray(v) ? v[0] : v;
const km = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371; };

export async function searchPlaces(q, near) {
  const ign = `https://data.geopf.fr/geocodage/search?index=poi&limit=10&lat=${near.lat}&lon=${near.lon}&q=${encodeURIComponent(q)}`;
  const box = [near.lon - 2, near.lat + 1.5, near.lon + 2, near.lat - 1.5].map(v => v.toFixed(3)).join(',');
  const osm = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=fr&viewbox=${box}&q=${encodeURIComponent(q)}`;
  const [a, b] = await Promise.all([
    timedFetch(ign, {}, 15000).then(r => r.ok ? r.json() : null).catch(() => null),
    timedFetch(osm, {}, 15000).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  if (!a && !b) throw new Error('recherche indisponible (connexion ?)');
  const out = [];
  for (const f of a?.features ?? []) {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    out.push({ name: first(p.name) ?? q, detail: [first(p.category), first(p.city)].filter(Boolean).join(' · '), cat: [p.category].flat().join(' '), lat, lon, src: 'IGN' });
  }
  for (const x of b ?? []) {
    const lat = +x.lat, lon = +x.lon;
    if (out.some(o => km(o, { lat, lon }) < 0.4)) continue; // found by both: keep the IGN entry
    const kind = { peak: 'sommet', alpine_hut: 'refuge', glacier: 'glacier', saddle: 'col', volcano: 'sommet', water: 'lac' }[x.type];
    out.push({ name: x.name || x.display_name.split(',')[0], detail: [kind, ...x.display_name.split(',').slice(1, 3).map(s => s.trim())].filter(Boolean).join(' · '), cat: `${x.category ?? ''} ${x.type ?? ''}`, lat, lon, src: 'OSM' });
  }
  // ranking: the name matching what was typed first (the gazetteer also returns merely similar names), then
  // mountain features before neighbourhoods and hamlets, then distance
  // tested on the category only (a town called Montvalezan is not a mountain)
  const MOUNTAIN = /\b(peak|sommet|pic|refuge|cabane|alpine_hut|wilderness_hut|glacier|lac|lake|water|col|saddle|mountain_pass|volcano|ridge|arête)\b/i;
  const MINOR = /\b(quartier|lieu-dit|neighbourhood|hamlet|residential|house|isolated_dwelling)\b/i;
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(le|la|les|l|du|de|des|d)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(q), words = nq.split(' ').filter(Boolean);
  out.forEach(o => {
    o.km = km(near, o);
    const n = norm(o.name), kind = o.cat;
    const match = n === nq ? 0.05 : words.every(w => n.includes(w)) ? 0.25 : 4;
    o.score = (o.km + 1) * match * (MOUNTAIN.test(kind) ? 0.5 : MINOR.test(kind) ? 2 : 1);
  });
  return out.sort((p, q2) => p.score - q2.score).slice(0, 8);
}
