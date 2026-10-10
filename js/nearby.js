// "Find me a hike": the hikes around a place (my position, the place looked at, or a place named), wherever it is in
// France, not only in the massif opened: the catalogues shipped with the app (all massifs), those built on this
// device, and new ones worked out around the place (hikes.js hikesAround). A sentence typed or said is read for
// a few key words (level, length, kind of goal, where); what was understood is said back, nothing more is guessed.
import { CLASS_NAMES } from './hikes.js?v=202610101121';

const SHIPPED = ['midi', 'buet', 'sassiere', 'ecrins', 'vanoise', 'belledonne'];
const metres = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371000; };
let shipped = null;
// every catalogue known: shipped files (loaded once) and those built on the device (massifs, places)
async function allCatalogues() {
  if (!shipped) shipped = (await Promise.all(SHIPPED.map(id => fetch(`data/hikes-${id}.json`).then(r => r.ok ? r.json() : null).catch(() => null)))).flatMap(d => d?.hikes ?? []);
  const own = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); if (!/^midi3d-hikes-/.test(k)) continue;
    try { own.push(...(JSON.parse(localStorage.getItem(k))?.hikes ?? [])); } catch { }
  }
  return [...own, ...shipped];
}
// the hikes whose start lies within radiusKm of the place, nearest start first, each once (name + kind + start)
export async function hikesNear(place, radiusKm) {
  const seen = new Set(), out = [];
  for (const h of await allCatalogues()) {
    if (!h.path?.length) continue;
    const [lon, lat] = h.path[0], d = metres(place, { lon, lat }), key = `${h.kind}/${h.name}/${h.start}`;
    if (d > radiusKm * 1000 || seen.has(key)) continue;
    seen.add(key); out.push({ ...h, away: d });
  }
  return out.sort((a, b) => a.away - b.away);
}

// ----- a sentence -----
const plain = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ');
const NUM = { une: 1, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8 };
const num = s => NUM[s] ?? parseFloat(String(s).replace(',', '.'));
// returns { levels, kinds, maxHours, minHours, maxUp, maxKm, where: 'me' | 'view' | { name }, said: [words understood] }
export function parseQuery(text) {
  const t = ` ${plain(text)} `, q = { levels: [], kinds: [], maxHours: null, minHours: null, maxUp: null, maxKm: null, where: null, said: [] };
  const lv = [[/facile|pas (trop )?(dur|difficile)|tranquille|famille|enfant|balade|promenade/, 'easy'], [/moyen/, 'medium'], [/difficile|sportif|sportive|costaud/, 'hard'], [/tres longue|longue/, 'long'], [/haute montagne|alpinisme|glacier/, 'alpine']];
  for (const [re, l] of lv) if (re.test(t) && !q.levels.includes(l)) q.levels.push(l);
  const kd = [[/\blacs?\b|etang/, 'lac'], [/refuge|cabane|dormir|nuit|bivouac|gite/, 'refuge'], [/sommet|\bpic\b|pointe|aiguille|\bmont\b|cime/, 'sommet'], [/\bcols?\b/, 'col']];
  for (const [re, k] of kd) if (re.test(t)) q.kinds.push(k);
  let m;
  // durations: "moins de 2 h", "moins de 2h30", "en deux heures", "max 3 h", "plus de 4 heures"
  const H = String.raw`(\d+(?:[.,]\d+)?|une?|deux|trois|quatre|cinq|six|sept|huit) ?(?:h|heures?)(?: ?(\d{2}))?`;
  const hours = mm => num(mm[1]) + (mm[2] ? +mm[2] / 60 : 0);
  if ((m = t.match(new RegExp(`(?:moins d(?:e)?|en|max(?:imum)?|pas plus d(?:e)?) ${H}`)))) q.maxHours = hours(m);
  else if (/demi[ -]?journee|matinee|apres[ -]?midi/.test(t)) q.maxHours = 4;
  else if (/journee/.test(t)) q.maxHours = 8;
  if ((m = t.match(new RegExp(`plus d(?:e)? ${H}`)))) q.minHours = hours(m);
  if ((m = t.match(/moins de (\d+) ?m(?:etres)?(?: de)? ?(?:d ?\+|denivele|de montee)/))) q.maxUp = +m[1];
  if ((m = t.match(/moins de (\d+(?:[.,]\d+)?) ?(?:km|kilometres?)\b(?! d)/))) q.maxKm = num(m[1]);
  if (/pres de moi|autour de moi|a cote de moi|proche de moi|a proximite|par ici|\bici\b|pas loin/.test(t)) q.where = 'me';
  else if ((m = t.match(/(?:pres d[eu]?|autour d[eu]?|vers|du cote d[eu]?|a cote d[eu]?|depuis|au depart d[eu]?) (?:la |le |les |l )?([a-z][a-z \-]{2,40}?)(?: a moins| en | pour | avec | facile| moyenne| difficile|$| \.)/))) q.where = { name: m[1].trim() };
  if (q.levels.length) q.said.push(q.levels.map(l => CLASS_NAMES[l].toLowerCase()).join(' ou '));
  if (q.kinds.length) q.said.push(q.kinds.map(k => ({ lac: 'un lac', refuge: 'un refuge', sommet: 'un sommet', col: 'un col' }[k])).join(' ou '));
  const hhmm = v => `${Math.floor(v)} h${v % 1 ? ` ${String(Math.round(v % 1 * 60)).padStart(2, '0')}` : ''}`;
  if (q.maxHours) q.said.push(`moins de ${hhmm(q.maxHours)} de marche (aller simple)`);
  if (q.minHours) q.said.push(`plus de ${hhmm(q.minHours)}`);
  if (q.maxUp) q.said.push(`moins de ${q.maxUp} m de montée`);
  if (q.maxKm) q.said.push(`moins de ${q.maxKm} km`);
  if (q.where === 'me') q.said.push('près de toi'); else if (q.where?.name) q.said.push(`autour de « ${q.where.name} »`);
  return q;
}
export function matches(h, q) {
  return (!q.levels.length || q.levels.includes(h.cls)) && (!q.kinds.length || q.kinds.includes(h.kind)) && (!q.maxHours || h.hours <= q.maxHours + 0.08)
    && (!q.minHours || h.hours >= q.minHours) && (!q.maxUp || h.up <= q.maxUp) && (!q.maxKm || h.dist <= q.maxKm * 1000);
}
