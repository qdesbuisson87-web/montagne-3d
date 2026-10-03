// Topos and recent outings from camptocamp.org (© its contributors, CC BY-SA 4.0). camptocamp only answers
// browsers on its own site, so a daily job on GitHub (scripts/c2c.py, .github/workflows/c2c.yml) copies the
// massif's routes and the outings of the last 45 days into data/c2c-<site>.json; the app reads that copy
// (kept for offline use) and always shows its date. Nothing here is rewritten: titles, ratings and the
// conditions are the climbers' own words, with a link to every page.
import { lonLatToWorld } from './geo.js?v=202610031435';

export const ACTIVITIES = {
  hiking: 'Randonnée', snow_ice_mixed: 'Neige, glace, mixte', mountain_climbing: 'Alpinisme rocheux', rock_climbing: 'Escalade',
  ice_climbing: 'Cascade de glace', skitouring: 'Ski de rando', snowshoeing: 'Raquettes', via_ferrata: 'Via ferrata',
  mountain_biking: 'VTT', paragliding: 'Parapente', slacklining: 'Slackline'
};
// filters offered in the app: one or several camptocamp activities each
export const FILTERS = [['all', 'Toutes', null], ['hike', 'Randonnée', ['hiking', 'snowshoeing']], ['alpi', 'Alpinisme', ['snow_ice_mixed', 'mountain_climbing']],
  ['ski', 'Ski de rando', ['skitouring']], ['rock', 'Escalade', ['rock_climbing']], ['ice', 'Cascade', ['ice_climbing']], ['vf', 'Via ferrata', ['via_ferrata']]];
export const CONDITIONS = { excellent: ['Excellentes', '#2e9e4f'], good: ['Bonnes', '#7cbf3a'], average: ['Moyennes', '#e0b020'], poor: ['Mauvaises', '#e0702a'], awful: ['Exécrables', '#c8322a'] };
const SNOW = { excellent: 'excellente', good: 'bonne', average: 'moyenne', poor: 'mauvaise', awful: 'exécrable' };
const GLACIER = { easy: 'facile', possible: 'possible', difficult: 'difficile', impossible: 'impossible' };
const AVA = { no: 'aucun signe', danger_sign: 'signes de danger', recent_avalanche: 'avalanches récentes', natural_avalanche: 'déclenchements naturels', accidental_avalanche: 'déclenchements accidentels' };

export async function loadC2C(site) {
  try { const r = await fetch(`data/c2c-${site.id}.json`); return r.ok ? await r.json() : null; } catch { return null; }
}

// the rating that matters for each activity, as climbers write it (T3, PD+, 6a, 3.2, WI4, K3…)
export function ratingText(r) {
  const R = r.rt || {}, a = r.act, out = [];
  if (a.includes('hiking') && R.hiking_rating) out.push(R.hiking_rating);
  if (a.includes('snowshoeing') && R.snowshoe_rating) out.push(R.snowshoe_rating);
  if (a.includes('skitouring') && R.ski_rating) out.push(`${R.ski_rating}${R.labande_global_rating ? ' ' + R.labande_global_rating : ''}`);
  if (R.global_rating && (a.includes('snow_ice_mixed') || a.includes('mountain_climbing') || a.includes('rock_climbing') || a.includes('ice_climbing'))) out.push(R.global_rating);
  if (R.rock_free_rating) out.push(R.rock_free_rating);
  if (R.ice_rating) out.push(R.ice_rating);
  if (R.via_ferrata_rating) out.push(R.via_ferrata_rating);
  if (R.engagement_rating) out.push(R.engagement_rating);
  return [...new Set(out)].join(' · ');
}
export const activityText = act => act.map(a => ACTIVITIES[a] || a).join(', ');
export const matches = (r, filter) => { const f = FILTERS.find(x => x[0] === filter)?.[2]; return !f || r.act.some(a => f.includes(a)); };

// index: outings by route, newest first; routes in scene coordinates
export function prepare(data) {
  const byRoute = new Map();
  for (const o of data.outings) for (const id of o.routes) { if (!byRoute.has(id)) byRoute.set(id, []); byRoute.get(id).push(o); }
  for (const l of byRoute.values()) l.sort((a, b) => (b.d || '').localeCompare(a.d || ''));
  for (const r of data.routes) { [r.x, r.z] = lonLatToWorld(r.ll[0], r.ll[1]); r.outings = byRoute.get(r.id) || []; }
  return data;
}
export const lineOf = (data, r) => data.lines?.[String(r.id)]?.map(([lon, lat]) => lonLatToWorld(lon, lat)) ?? null;

export function snowText(s) {
  if (!s) return '';
  const p = [];
  if (s.elevation_up_snow) p.push(`neige dès ${s.elevation_up_snow} m à la montée`);
  if (s.elevation_down_snow) p.push(`jusqu'à ${s.elevation_down_snow} m à la descente`);
  if (s.snow_quality) p.push(`qualité ${SNOW[s.snow_quality] || s.snow_quality}`);
  if (s.snow_quantity) p.push(`quantité ${SNOW[s.snow_quantity] || s.snow_quantity}`);
  if (s.glacier_rating) p.push(`glacier ${GLACIER[s.glacier_rating] || s.glacier_rating}`);
  if (s.avalanche_signs?.length) p.push(`avalanches : ${[].concat(s.avalanche_signs).map(a => AVA[a] || a).join(', ')}`);
  return p.join(' · ');
}
