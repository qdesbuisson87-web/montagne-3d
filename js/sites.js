// One entry per massif. The selected site sets the scene origin, the streamed area, the weather stations,
// the named places and the offline pack. Switch with ?site=<id> (remembered on the device).
const SITES = {
  midi: {
    id: 'midi', name: 'Aiguille du Midi', alt: 3842, region: 'Massif du Mont-Blanc · Chamonix',
    origin: { lat: 45.8786, lon: 6.8872 },
    geoidN: 53.4,                                // EGM2008 geoid above the WGS84 ellipsoid at the origin (Google 3D heights are ellipsoidal)
    bounds: [6.45, 45.62, 7.35, 46.12],          // streamed area (lon/lat)
    core: [6.80, 45.82, 6.97, 45.935],           // snow statistics + offline pack
    detail: [6.874, 45.868, 6.902, 45.890],      // 20 cm level in the "Maximum" offline pack
    spots: {
      top: { name: 'Aiguille du Midi', lat: 45.8786, lon: 6.8872, alt: 3842 },
      peak2: { name: 'Mont Blanc', lat: 45.8326, lon: 6.8652, alt: 4806 },
      mid: { name: 'Plan de l’Aiguille', lat: 45.8924, lon: 6.8849, alt: 2317 },
      valley: { name: 'Chamonix', lat: 45.9237, lon: 6.8694, alt: 1035 }
    },
    home: { dy: 80, cam: [-560, 200, -680] },
    cable: [[45.9188, 6.8703, 1035], [45.8918, 6.8858, 2317], [45.8791, 6.8871, 3777]],
    places: [
      { id: 'top', name: 'Aiguille du Midi', alt: 3842, ll: [45.8786, 6.8872], star: true, dist: 900 },
      { name: 'Mont Blanc', alt: 4806, ll: [45.8326, 6.8652], dist: 2600 },
      { name: 'Mont Maudit', alt: 4465, ll: [45.8497, 6.8753] },
      { name: 'Mont Blanc du Tacul', alt: 4248, ll: [45.8567, 6.8876] },
      { name: 'Dôme du Goûter', alt: 4304, ll: [45.8428, 6.8434] },
      { name: 'Aiguille Verte', alt: 4122, ll: [45.9344, 6.9706] },
      { name: 'Les Drus', alt: 3754, ll: [45.9328, 6.9557] },
      { name: 'Grandes Jorasses', alt: 4208, ll: [45.8686, 6.9876] },
      { name: 'Dent du Géant', alt: 4013, ll: [45.8622, 6.9519] },
      { name: 'Aiguille du Plan', alt: 3673, ll: [45.8906, 6.9097] },
      { name: 'Pointe Helbronner', alt: 3462, ll: [45.8458, 6.9332] },
      { name: 'Le Brévent', alt: 2525, ll: [45.9336, 6.8367] },
      { name: 'Plan de l’Aiguille', alt: 2317, ll: [45.8924, 6.8849], small: true },
      { name: 'Montenvers', alt: 1913, ll: [45.9280, 6.9190], small: true },
      { name: 'Chamonix', alt: 1035, ll: [45.9237, 6.8694] },
      { name: 'Mer de Glace', ll: [45.9135, 6.9305], area: true },
      { name: 'Vallée Blanche', ll: [45.8700, 6.9150], area: true },
      { name: 'Glacier des Bossons', ll: [45.8750, 6.8520], area: true }
    ],
    links: [
      ['https://meteofrance.com/meteo-montagne/mont-blanc', "Bulletin d'avalanche et météo montagne Mont-Blanc — Météo-France"],
      ['https://www.chamoniarde.com/', 'Office de Haute Montagne (La Chamoniarde) — conditions des itinéraires'],
      ['https://www.montblancnaturalresort.com/fr/webcams', "Webcams de l'Aiguille du Midi — Compagnie du Mont-Blanc"],
      ['https://www.chamonix.com/webcams', 'Webcams de la vallée — Chamonix']
    ]
  },
  sassiere: {
    id: 'sassiere', name: 'Grande Sassière', alt: 3747, region: 'Haute-Tarentaise · Tignes',
    origin: { lat: 45.5050, lon: 6.99972 },
    geoidN: 54.8,
    bounds: [6.65, 45.28, 7.35, 45.72],
    core: [6.84, 45.40, 7.10, 45.56],
    detail: [6.985, 45.492, 7.016, 45.515],
    spots: {
      top: { name: 'Grande Sassière', lat: 45.5050, lon: 6.99972, alt: 3747 },
      peak2: { name: 'Tsanteleina', lat: 45.47955, lon: 7.04593, alt: 3602 },
      mid: { name: 'Lac de la Sassière', lat: 45.4849, lon: 7.0055, alt: 2460 },
      valley: { name: 'Val-d’Isère', lat: 45.4506, lon: 6.9781, alt: 1850 }
    },
    home: { dy: 90, cam: [-620, 180, 560] },
    cable: null,
    places: [
      { id: 'top', name: 'Aiguille de la Grande Sassière', alt: 3747, ll: [45.5050, 6.99972], star: true, dist: 1100 },
      { name: 'Tsanteleina', alt: 3602, ll: [45.47955, 7.04593] },
      { name: 'Mont Pourri', alt: 3779, ll: [45.52833, 6.86] },
      { name: 'Dôme de la Sache', alt: 3601, ll: [45.5111, 6.87056] },
      { name: 'Grande Motte', alt: 3653, ll: [45.41111, 6.87028] },
      { name: 'Pointe de la Galise', alt: 3343, ll: [45.46694, 7.10444] },
      { name: 'Refuge de la Martin', alt: 2154, ll: [45.52381, 6.90015], small: true },
      { name: 'Tignes', alt: 2100, ll: [45.47333, 6.91389] },
      { name: 'Val-d’Isère', alt: 1850, ll: [45.4506, 6.9781] },
      { name: 'Lac de la Sassière', ll: [45.4849, 7.0055], area: true },
      { name: 'Lac du Chevril', ll: [45.4848, 6.93932], area: true }
    ],
    links: [
      ['https://meteofrance.com/meteo-montagne/haute-tarentaise', "Bulletin d'avalanche et météo montagne Haute-Tarentaise — Météo-France"],
      ['https://www.tignes.net/webcams', 'Webcams de Tignes'],
      ['https://www.valdisere.com/live/webcams/', 'Webcams de Val-d’Isère']
    ]
  }
};

let pick = 'midi';
try { pick = new URLSearchParams(location.search).get('site') || localStorage.getItem('midi3d-site') || 'midi'; } catch { }
export const SITE = SITES[pick] || SITES.midi;
try { localStorage.setItem('midi3d-site', SITE.id); } catch { }
export const SITE_LIST = Object.values(SITES).map(s => ({ id: s.id, name: s.name, region: s.region, alt: s.alt }));
