// The outing planned for a day: kept on the device with its itinerary, checked again each time the app opens in
// the days before (forecast at its highest point for the hours one walks, thunderstorms, avalanche bulletin), and
// reminders on the phone through ntfy.sh (free public message service with a phone app, the same as the live
// position): a message scheduled the evening before and an hour before leaving, saying to open the app. A web app
// cannot wake itself up at a given hour (not at all on iPhone): the message carries no forecast of its own, which
// would be old by then; the app checks when it opens. ntfy keeps a scheduled message up to 3 days ahead.
import { timedFetch } from './net.js?v=202610101240';

const STORE = 'midi3d-planned', TOPIC = 'midi3d-ntfy-topic', HOST = 'https://ntfy.sh';
export const loadPlanned = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };
export const savePlanned = p => { try { if (p) localStorage.setItem(STORE, JSON.stringify(p)); else localStorage.removeItem(STORE); } catch { } };
// the device's own channel for reminders (24 random characters: only who has its name can read it)
export function reminderTopic(create = false) {
  let t = null; try { t = localStorage.getItem(TOPIC); } catch { }
  if (!t && create) { t = 'm3d-' + [...crypto.getRandomValues(new Uint8Array(18))].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join(''); try { localStorage.setItem(TOPIC, t); } catch { } }
  return t;
}
// the day and hour of leaving, local time
export const leaveAt = p => new Date(`${p.date}T${p.start || '07:00'}:00`);

// reminders: the evening before at 19 h and an hour before leaving, those still ahead and within ntfy's 3 days
export async function scheduleReminders(p, link) {
  const topic = reminderTopic(true), leave = leaveAt(p), eve = new Date(leave); eve.setDate(eve.getDate() - 1); eve.setHours(19, 0, 0, 0);
  const plan = [
    { at: eve, title: `Demain : ${p.name}`, message: `Départ prévu à ${p.start}. Ouvre l'appli pour la météo et le bulletin d'avalanche à jour.` },
    { at: new Date(+leave - 3600e3), title: `Dans une heure : ${p.name}`, message: "Ouvre l'appli : prévision et alerte orage pour la journée." }
  ].filter(r => r.at > Date.now() + 60e3 && r.at < Date.now() + 3 * 864e5 - 60e3);
  const sent = [];
  for (const r of plan) {
    // JSON publishing (text body: no preflight); "delay" as a Unix time
    const res = await timedFetch(`${HOST}/`, { method: 'POST', body: JSON.stringify({ topic, title: r.title, message: r.message, click: link, tags: ['mountain'], delay: String(Math.round(+r.at / 1000)) }) }, 15000);
    if (!res.ok) throw new Error(res.status === 429 ? "limite du service atteinte pour aujourd'hui" : `service ${res.status}`);
    sent.push({ id: (await res.json()).id, at: +r.at });
  }
  return { topic, sent, later: plan.length === 0 && leave > Date.now() };
}
// scheduled messages taken back (a plan changed or cancelled)
export async function cancelReminders(p) {
  const topic = reminderTopic(); if (!topic) return;
  await Promise.all((p?.reminders ?? []).filter(r => r.at > Date.now()).map(r => timedFetch(`${HOST}/${topic}/${r.id}`, { method: 'DELETE' }, 15000).catch(() => null)));
}
