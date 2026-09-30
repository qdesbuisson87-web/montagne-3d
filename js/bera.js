// Avalanche risk bulletin (BERA) of Météo-France, official API "DonneesPubliquesBRA", with the owner's own key
// (typed in the app, stored on the device only, sent only to Météo-France). The bulletin is issued daily around
// 16:00 from early November to late May. Besides the risk it carries what the forecasters know of the snow:
// depth by altitude on north and south slopes, snow line, fresh snow of the last days. Nothing is computed or
// guessed here: every figure is the bulletin's, with its date. The last bulletin is kept for offline use.
const API = id => `https://public-api.meteofrance.fr/public/DPBRA/v1/massif/BRA?id-massif=${id}&format=xml`;
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
function parse(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml'), root = doc.querySelector('BULLETINS_NEIGE_AVALANCHE');
  if (!root || doc.querySelector('parsererror')) throw new BeraError('format', 'réponse illisible');
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
  const key = beraKey.get(); if (!key) throw new BeraError('nokey', 'clé Météo-France absente');
  let r;
  try { r = await fetch(API(massifId), { headers: { apikey: key } }); }
  catch {
    const saved = (() => { try { return localStorage.getItem(STORE(massifId)); } catch { return null; } })();
    if (saved) return { ...parse(saved), offline: true };
    throw new BeraError('network', 'pas de connexion');
  }
  if (r.status === 401 || r.status === 403) throw new BeraError('key', 'clé refusée par Météo-France');
  if (r.status === 404 || r.status === 204) throw new BeraError('none', 'aucun bulletin publié pour ce massif');
  if (!r.ok) throw new BeraError('server', `Météo-France répond ${r.status}`);
  const xml = await r.text();
  const b = parse(xml);
  try { localStorage.setItem(STORE(massifId), xml); } catch { }
  return b;
}
