// Avalanche risk bulletin (BERA) of Météo-France: the public file meteofrance.com publishes for each massif (open to
// other sites, no key needed: checked 03/10/2026), or the official API "DonneesPubliquesBRA" when the owner has
// typed his own key (stored on the device only, sent only to Météo-France). The bulletin is issued daily around
// 16:00 from early November to late May. Besides the risk it carries what the forecasters know of the snow:
// depth by altitude on north and south slopes, snow line, fresh snow of the last days. Nothing is computed or
// guessed here: every figure is the bulletin's, with its date. The last bulletin is kept for offline use.
import { timedFetch } from './net.js?v=202610031435';

const API = id => `https://public-api.meteofrance.fr/public/DPBRA/v1/massif/BRA?id-massif=${id}&format=xml`;
// the same bulletin as published on meteofrance.com (without a key, or when the API answer cannot be read)
const PUBLIC = id => `https://api.meteofrance.com/files/mountain/bulletins/BRA${String(id).padStart(2, '0')}.xml`;
const KEY = 'midi3d-mf-key', STORE = id => `midi3d-bera-${id}`;

export const beraKey = {
  get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
  set(k) { try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch { } }
};
// European avalanche danger scale
export const RISK = {
  1: { name: 'Faible', color: '#ccff66' }, 2: { name: 'Limité', color: '#ffff00' }, 3: { name: 'Marqué', color: '#ff9900' },
  4: { name: 'Fort', color: '#ff0000' }, 5: { name: 'Très fort', color: '#a00000' }
};

export class BeraError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

const num = v => (v === '' || v == null || +v < 0) ? null : +v; // "" and -1 mean "not given"
// the bulletin XML, wherever it is in the answer (plain XML, or a string inside a JSON envelope)
function extractXml(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { let found = null; JSON.parse(t, (k, v) => { if (typeof v === 'string' && v.includes('<BULLETINS_NEIGE_AVALANCHE')) found = v; return v; }); if (found) return found; } catch { }
  }
  const i = t.indexOf('<BULLETINS_NEIGE_AVALANCHE');
  return i < 0 ? null : t.slice(i, t.lastIndexOf('</BULLETINS_NEIGE_AVALANCHE>') + 28);
}
function parse(text) {
  const xml = extractXml(text);
  const doc = xml && new DOMParser().parseFromString(xml, 'application/xml'), root = doc?.querySelector('BULLETINS_NEIGE_AVALANCHE');
  if (!root || doc.querySelector('parsererror')) throw new BeraError('format', `réponse non reconnue (début : « ${text.replace(/\s+/g, ' ').slice(0, 90)} »)`);
  const $ = s => root.querySelector(s), txt = s => ($(s)?.textContent ?? '').trim(), at = (el, a) => el?.getAttribute(a) ?? '';
  const r = $('CARTOUCHERISQUE > RISQUE'), p = $('CARTOUCHERISQUE > PENTE');
  const enn = $(':scope > ENNEIGEMENT'), nf = $(':scope > NEIGEFRAICHE');
  return {
    massif: at(root, 'MASSIF'), id: at(root, 'ID'),
    issued: new Date(at(root, 'DATEBULLETIN')), validUntil: new Date(at(root, 'DATEVALIDITE') || at(root, 'DATEECHEANCE')),
    amended: at(root, 'AMENDEMENT') === 'true',
    risk1: num(at(r, 'RISQUE1')), evol1: num(at(r, 'EVOLURISQUE1')), risk2: num(at(r, 'RISQUE2')), evol2: num(at(r, 'EVOLURISQUE2')),
    altitude: num(at(r, 'ALTITUDE')), riskMax: num(at(r, 'RISQUEMAXI')), riskJ2: num(at(r, 'RISQUEMAXIJ2')), comment: at(r, 'COMMENTAIRE'),
    aspects: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].filter(k => at(p, k) === 'true'), aspectNote: at(p, 'COMMENTAIRE'),
    accidental: txt('CARTOUCHERISQUE > ACCIDENTEL'), natural: txt('CARTOUCHERISQUE > NATUREL'), summary: txt('CARTOUCHERISQUE > RESUME'),
    j2: txt('CARTOUCHERISQUE > CommentaireRisqueJ2'),
    stabilityTitle: txt('STABILITE > TITRE'), stability: txt('STABILITE > TEXTESANSTITRE') || txt('STABILITE > TEXTE'),
    quality: txt('QUALITE > TEXTE'),
    snow: enn ? { date: new Date(at(enn, 'DATE')), lineN: num(at(enn, 'LimiteNord')), lineS: num(at(enn, 'LimiteSud')),
      levels: [...enn.querySelectorAll('NIVEAU')].map(n => ({ alt: +at(n, 'ALTI'), n: num(at(n, 'N')), s: num(at(n, 'S')) })) } : null,
    fresh: nf ? { alt: num(at(nf, 'ALTITUDESS')), days: [...nf.querySelectorAll('NEIGE24H')].map(n => ({ date: new Date(at(n, 'DATE')), min: num(at(n, 'SS24Min')), max: num(at(n, 'SS24Max')) })) } : null,
    weather: txt(':scope > METEO > COMMENTAIRE')
  };
}

// latest bulletin of a massif; falls back to the stored copy (flagged) when offline
export async function fetchBera(massifId) {
  const key = beraKey.get();
  let r;
  try { r = await timedFetch(key ? API(massifId) : PUBLIC(massifId), key ? { headers: { apikey: key } } : {}, 20000); }
  catch {
    const saved = (() => { try { return localStorage.getItem(STORE(massifId)); } catch { return null; } })();
    if (saved) return { ...parse(saved), offline: true };
    throw new BeraError('network', 'pas de connexion');
  }
  if (!key) { // the public file: as it is
    if (!r.ok) throw new BeraError(r.status === 404 ? 'none' : 'server', `code ${r.status}`);
    const pub = await r.text(), b = { ...parse(pub), source: 'public' };
    try { localStorage.setItem(STORE(massifId), pub); } catch { }
    return b;
  }
  if (!r.ok || r.status === 204) {
    // keep Météo-France's own words: they tell apart a wrong key, a missing subscription and "no bulletin"
    const body = await r.text().catch(() => ''), said = (body.match(/"description"\s*:\s*"([^"]+)"/) ?? body.match(/"message"\s*:\s*"([^"]+)"/) ?? [])[1] ?? body.replace(/<[^>]+>/g, ' ').trim().slice(0, 160);
    const detail = `code ${r.status}${said ? ` : « ${said} »` : ''}`;
    if (r.status === 401 || r.status === 403) throw new BeraError('key', detail);
    if (r.status === 404 || r.status === 204) throw new BeraError('none', detail);
    throw new BeraError('server', detail);
  }
  const xml = await r.text();
  let b;
  try { b = parse(xml); }
  catch (e) {
    // the key works but the answer is not a bulletin: take the same bulletin from Météo-France's public file
    const pub = await timedFetch(PUBLIC(massifId), {}, 20000).then(p => p.ok ? p.text() : null).catch(() => null);
    if (!pub) throw e;
    b = { ...parse(pub), source: 'public' };
    try { localStorage.setItem(STORE(massifId), pub); } catch { }
    return b;
  }
  try { localStorage.setItem(STORE(massifId), xml); } catch { }
  return b;
}
