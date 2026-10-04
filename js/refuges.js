// Huts, shelters, water points and tricky passages from refuges.info (© its contributors, CC BY-SA 2.0): what
// hikers write about them (beds, water, stove, blankets, how to get there, who to call, remarks, last update).
// Fetched by cells of 0.1° around the view, kept for offline use. Shown as their own words, with the link.
import { cachedFetch } from './net.js?v=202610042100';
import { worldToLonLat, lonLatToWorld } from './geo.js?v=202610042100';

const CELL = 0.1;
const API = (w, s, e, n) => `https://www.refuges.info/api/bbox?bbox=${w},${s},${e},${n}&type_points=all&format=geojson&detail=complet`;
// the kinds kept, and how the app calls them
export const KINDS = { 'refuge gardé': 'refuge', "gîte d'étape": 'gîte', 'cabane non gardée': 'cabane', 'point d\'eau': 'eau', 'passage délicat': 'passage' };

const clean = s => String(s ?? '').replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/gi, '$2 ($1)').replace(/\[\/?[a-z]+[^\]]*\]/gi, '').replace(/\r/g, '').trim();

export class Refuges {
  constructor(onPoints) { this.cells = new Set(); this.ids = new Set(); this.onPoints = onPoints; }
  ensure(x, z, radius = 12000) {
    const [lon, lat] = worldToLonLat(x, z), dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue; this.cells.add(key);
      cachedFetch(API(b * CELL, a * CELL, (b + 1) * CELL, (a + 1) * CELL)).then(r => r.ok ? r.json() : null).then(j => {
        if (!j) { this.cells.delete(key); return; }
        const pts = [];
        for (const f of j.features ?? []) {
          const p = f.properties, kind = KINDS[p.type?.valeur]; if (!kind || this.ids.has(p.id)) continue; this.ids.add(p.id);
          const [lo, la] = f.geometry.coordinates, [wx, wz] = lonLatToWorld(lo, la);
          const comp = Object.values(p.info_comp ?? {}).filter(v => v?.nom && v.valeur && v.valeur !== 'Non' && v.valeur !== 'Inconnu').map(v => `${v.nom}${v.valeur === 'Oui' ? '' : ` : ${v.valeur}`}`);
          pts.push({ id: p.id, name: p.nom, kind, type: p.type.valeur, lon: lo, lat: la, x: wx, z: wz, alt: p.coord?.alt ?? null,
            places: p.places?.valeur ?? null, comp, access: clean(p.acces?.valeur), remark: clean(p.remarque?.valeur), owner: clean(p.proprio?.valeur), ownerLabel: p.proprio?.nom,
            updated: p.date?.derniere_modif?.slice(0, 10), link: p.lien, state: p.etat?.valeur });
        }
        if (pts.length) this.onPoints(pts);
      }).catch(() => this.cells.delete(key)); // asked again later
    }
  }
}
