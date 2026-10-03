// One entry per massif. The selected site sets the scene origin, the streamed area, the weather stations,
// the named places and the offline pack. Switch with ?site=<id> (remembered on the device).
const SITES = {
  midi: {
    id: 'midi', name: 'Aiguille du Midi', alt: 3842, region: 'Massif du Mont-Blanc · Chamonix',
    origin: { lat: 45.8786, lon: 6.8872 },
    geoidN: 53.4,                                // EGM2008 geoid above the WGS84 ellipsoid at the origin (Google 3D heights are ellipsoidal)
    bra: 3,                                      // Météo-France avalanche bulletin massif number (Mont-Blanc)
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
  // Coordinates: IGN gazetteer (Géoplateforme). Altitudes: official map heights where known (Mont Buet 3096,
  // Cheval Blanc 2831, Aiguille du Belvédère 2965), otherwise the highest IGN RGE ALTI point within 60 m.
  buet: {
    id: 'buet', name: 'Mont Buet', alt: 3096, region: 'Aiguilles Rouges · Vallorcine · Sixt',
    origin: { lat: 46.0248, lon: 6.85256 },
    geoidN: 52.8, // EGM2008 at the summit
    bra: 3,       // BERA massif Mont-Blanc (covers the Aiguilles Rouges and the Buet)
    bounds: [6.40, 45.78, 7.30, 46.27],
    core: [6.78, 45.97, 6.95, 46.08],
    detail: [6.838, 46.014, 6.866, 46.035],
    spots: {
      top: { name: 'Mont Buet', lat: 46.0248, lon: 6.85256, alt: 3096 },
      peak2: { name: 'Cheval Blanc', lat: 46.05196, lon: 6.87267, alt: 2831 },
      mid: { name: 'Refuge de la Pierre à Bérard', lat: 46.00298, lon: 6.86872, alt: 1925 },
      valley: { name: 'Vallorcine', lat: 46.03277, lon: 6.92932, alt: 1290 }
    },
    home: { dy: 70, cam: [620, 230, 700] },
    cable: null,
    places: [
      { id: 'top', name: 'Mont Buet', alt: 3096, ll: [46.0248, 6.85256], star: true, dist: 1100 },
      { name: 'Le Cheval Blanc', alt: 2831, ll: [46.05196, 6.87267] },
      { name: 'Pointe du Genévrier', alt: 2850, ll: [46.03745, 6.85519] },
      { name: 'Tête du Grenairon', alt: 2713, ll: [46.06534, 6.87900] },
      { name: 'Aiguille de Salenton', alt: 2647, ll: [46.00914, 6.85399] },
      { name: 'Aiguille du Belvédère', alt: 2965, ll: [45.98781, 6.87345] },
      { name: 'Col de Salenton', alt: 2516, ll: [46.00711, 6.85515], small: true },
      { name: 'Col de Bérard', alt: 2452, ll: [45.99129, 6.85746], small: true },
      { name: 'Refuge de la Pierre à Bérard', alt: 1925, ll: [46.00298, 6.86872], small: true },
      { name: 'Refuge du Grenairon', alt: 1949, ll: [46.03223, 6.79835], small: true },
      { name: 'Le Buet', alt: 1337, ll: [46.01914, 6.91954], small: true },
      { name: 'Vallorcine', alt: 1290, ll: [46.03277, 6.92932] },
      { name: 'Mont Blanc', alt: 4806, ll: [45.8326, 6.8652] },
      { name: 'Aiguille Verte', alt: 4122, ll: [45.9344, 6.9706] }
    ],
    links: [
      ['https://meteofrance.com/meteo-montagne/mont-blanc', "Bulletin d'avalanche et météo montagne Mont-Blanc — Météo-France"],
      ['https://www.chamoniarde.com/', 'Office de Haute Montagne (La Chamoniarde) — conditions des itinéraires']
    ]
  },
  sassiere: {
    id: 'sassiere', name: 'Grande Sassière', alt: 3747, region: 'Haute-Tarentaise · Tignes',
    origin: { lat: 45.5050, lon: 6.99972 },
    geoidN: 54.8,
    bra: 6,       // BERA massif Haute-Tarentaise
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
  },
  // Massif des Écrins · Vallouise-Pelvoux — made from IGN data (BD TOPO names, RGE ALTI altitudes: highest point within 40 m), official summit altitude,
  // EGM2008 geoid (GeographicLib), avalanche bulletin massif checked on Météo-France's public file (03/10/2026)
  ecrins: {"id": "ecrins", "name": "Barre des Écrins", "alt": 4102, "region": "Massif des Écrins · Vallouise-Pelvoux", "origin": {"lat": 44.922374, "lon": 6.359888}, "geoidN": 54.5, "bra": 16, "bounds": [5.909408, 44.622034, 6.809408, 45.222034], "core": [6.274408, 44.864034, 6.444408, 44.980034], "detail": [6.345408, 44.911034, 6.373408, 44.933034], "spots": {"top": {"name": "Barre des Écrins", "lat": 44.922374, "lon": 6.359888, "alt": 4102}, "peak2": {"name": "Doigt de Dieu ou Pic Central", "lat": 45.004003, "lon": 6.31368, "alt": 3927}, "mid": {"name": "Mi-pente", "lat": 44.882632, "lon": 6.420878, "alt": 2251}, "valley": {"name": "l'Auchette", "lat": 44.84323, "lon": 6.482347, "alt": 1183}}, "home": {"dy": 80, "cam": [-620, 260, -700]}, "cable": null, "places": [{"id": "top", "name": "Barre des Écrins", "alt": 4102, "ll": [44.922374, 6.359888], "star": true, "dist": 1000}, {"name": "Doigt de Dieu ou Pic Central", "alt": 3927, "ll": [45.004003, 6.31368]}, {"name": "Pic Oriental", "alt": 3860, "ll": [45.003613, 6.318793]}, {"name": "Grand Pic ou Pic Occidental", "alt": 3880, "ll": [45.005109, 6.308223]}, {"name": "Pic Gaspard", "alt": 3854, "ll": [44.997916, 6.331182]}, {"name": "le Râteau", "alt": 3730, "ll": [45.000636, 6.28093]}, {"name": "Clocher des Écrins", "alt": 3748, "ll": [44.92344, 6.349139]}, {"name": "Tête des Corridors", "alt": 3736, "ll": [45.006821, 6.3175]}, {"name": "l'Ourson", "alt": 3760, "ll": [44.998757, 6.325822]}, {"name": "le Pavé", "alt": 3737, "ll": [44.998537, 6.323178]}, {"name": "Pointe Brevoort", "alt": 3723, "ll": [44.967512, 6.328636]}, {"name": "Pic du Glacier Carré", "alt": 3696, "ll": [45.004578, 6.305551]}, {"name": "Pic Maître", "alt": 3676, "ll": [44.969272, 6.329028]}, {"name": "Roche Méane", "alt": 3656, "ll": [44.969979, 6.334903]}, {"name": "Pic de la Grave", "alt": 3635, "ll": [44.995102, 6.253654]}, {"name": "Pic Bourcet", "alt": 3638, "ll": [44.962901, 6.324361]}, {"name": "Tour Carrée", "alt": 3644, "ll": [44.970945, 6.336076]}, {"name": "les Rouies", "alt": 3557, "ll": [44.864228, 6.257761]}, {"name": "Dôme de la Lauze", "alt": 3549, "ll": [44.996714, 6.245758]}, {"name": "Pointe Madeleine", "alt": 3586, "ll": [44.996643, 6.263028]}, {"name": "les Jumeaux", "alt": 3546, "ll": [44.971555, 6.339875]}, {"name": "Pointe Thorant", "alt": 3552, "ll": [44.995952, 6.262955]}, {"name": "Cime de Clot Châtel", "alt": 3556, "ll": [44.897389, 6.279464]}, {"name": "Pointe Marie-Louise", "alt": 3525, "ll": [44.997014, 6.257381]}, {"name": "Tête de l'Étret", "alt": 3533, "ll": [44.889893, 6.24431]}, {"name": "l'Auchette", "alt": 1183, "ll": [44.84323, 6.482347]}], "links": [["https://meteofrance.com/meteo-montagne/pelvoux", "Bulletin d'avalanche et météo montagne Pelvoux — Météo-France"], ["https://www.ecrins-parcnational.fr/", "Parc national des Écrins"]]},
  // Massif de la Vanoise · Pralognan — made from IGN data (BD TOPO names, RGE ALTI altitudes: highest point within 40 m), official summit altitude,
  // EGM2008 geoid (GeographicLib), avalanche bulletin massif checked on Météo-France's public file (03/10/2026)
  vanoise: {"id": "vanoise", "name": "Grande Casse", "alt": 3855, "region": "Massif de la Vanoise · Pralognan", "origin": {"lat": 45.405089, "lon": 6.827483}, "geoidN": 54.6, "bra": 10, "bounds": [6.377483, 45.105089, 7.277483, 45.705089], "core": [6.742483, 45.347089, 6.912483, 45.463089], "detail": [6.813483, 45.394089, 6.841483, 45.416089], "spots": {"top": {"name": "Grande Casse", "lat": 45.405089, "lon": 6.827483, "alt": 3855}, "peak2": {"name": "Pointe Mathews", "lat": 45.397228, "lon": 6.820194, "alt": 3700}, "mid": {"name": "Mi-pente", "lat": 45.392106, "lon": 6.777192, "alt": 2480}, "valley": {"name": "le Martinet", "lat": 45.379123, "lon": 6.7269, "alt": 1439}}, "home": {"dy": 80, "cam": [-620, 260, -700]}, "cable": null, "places": [{"id": "top", "name": "Grande Casse", "alt": 3855, "ll": [45.405089, 6.827483], "star": true, "dist": 1000}, {"name": "Pointe Mathews", "alt": 3700, "ll": [45.397228, 6.820194]}, {"name": "la Grande Motte", "alt": 3640, "ll": [45.410951, 6.870126]}, {"name": "Dôme de Chasseforêt", "alt": 3586, "ll": [45.330759, 6.760688]}, {"name": "Dôme Nord", "alt": 3576, "ll": [45.315102, 6.742901]}, {"name": "Grand Roc Noir", "alt": 3581, "ll": [45.330531, 6.891481]}, {"name": "Dôme des Nants", "alt": 3552, "ll": [45.326632, 6.742733]}, {"name": "Dôme de l'Arpont", "alt": 3574, "ll": [45.318687, 6.743837]}, {"name": "Pointe Sud-Ouest", "alt": 3478, "ll": [45.331856, 6.954894]}, {"name": "Pointes de la Frêche", "alt": 3462, "ll": [45.32609, 6.911848]}, {"name": "Pointe de la Sana", "alt": 3434, "ll": [45.385088, 6.917533]}, {"name": "Sommet de Bellecôte", "alt": 3412, "ll": [45.492503, 6.782235]}, {"name": "Pointe des Broès", "alt": 3397, "ll": [45.342008, 6.911094]}, {"name": "Aiguille de l'Épéna", "alt": 3418, "ll": [45.414461, 6.817073]}, {"name": "le Grand Bec", "alt": 3393, "ll": [45.423519, 6.752915]}, {"name": "Pointe du Vallonnet", "alt": 3366, "ll": [45.417234, 6.760801]}, {"name": "Pointe du Vallonbrun", "alt": 3401, "ll": [45.330088, 6.938176]}, {"name": "Pointe Orientale de l'Épéna", "alt": 3345, "ll": [45.415366, 6.811928]}, {"name": "Pyramide du Vallonbrun", "alt": 3363, "ll": [45.332135, 6.947899]}, {"name": "Pointe de la Petite Glière", "alt": 3315, "ll": [45.410539, 6.79596]}, {"name": "Dôme des Pichères", "alt": 3317, "ll": [45.492035, 6.798286]}, {"name": "Pointe du Charbonnier", "alt": 3309, "ll": [45.380501, 6.901081]}, {"name": "Dôme de Bellecôte", "alt": 3320, "ll": [45.490799, 6.785436]}, {"name": "Pointe Centrale de l'Épéna", "alt": 3303, "ll": [45.414954, 6.806457]}, {"name": "le Martinet", "alt": 1439, "ll": [45.379123, 6.7269]}], "links": [["https://meteofrance.com/meteo-montagne/vanoise", "Bulletin d'avalanche et météo montagne Vanoise — Météo-France"], ["https://www.vanoise-parcnational.fr/fr", "Parc national de la Vanoise"]]},
  // Chaîne de Belledonne · Isère — made from IGN data (BD TOPO names, RGE ALTI altitudes: highest point within 40 m), official summit altitude,
  // EGM2008 geoid (GeographicLib), avalanche bulletin massif checked on Météo-France's public file (03/10/2026)
  belledonne: {"id": "belledonne", "name": "Grand Pic de Belledonne", "alt": 2977, "region": "Chaîne de Belledonne · Isère", "origin": {"lat": 45.17074, "lon": 5.991548}, "geoidN": 52.8, "bra": 8, "bounds": [5.541548, 44.87074, 6.441548, 45.47074], "core": [5.906548, 45.11274, 6.076548, 45.22874], "detail": [5.977548, 45.15974, 6.005548, 45.18174], "spots": {"top": {"name": "Grand Pic de Belledonne", "lat": 45.17074, "lon": 5.991548, "alt": 2977}, "peak2": {"name": "Pic de l'Herpie", "lat": 45.109713, "lon": 6.115873, "alt": 2995}, "mid": {"name": "Mi-pente", "lat": 45.206705, "lon": 5.939014, "alt": 922}, "valley": {"name": "Villard-Bonnot", "lat": 45.24267, "lon": 5.886479, "alt": 223}}, "home": {"dy": 80, "cam": [-620, 260, -700]}, "cable": null, "places": [{"id": "top", "name": "Grand Pic de Belledonne", "alt": 2977, "ll": [45.17074, 5.991548], "star": true, "dist": 1000}, {"name": "Pic de l'Herpie", "alt": 2995, "ll": [45.109713, 6.115873]}, {"name": "le Rocher Blanc", "alt": 2923, "ll": [45.241316, 6.107519]}, {"name": "Rocher Badon", "alt": 2899, "ll": [45.247516, 6.108889]}, {"name": "la Croix de Belledonne", "alt": 2893, "ll": [45.168541, 5.988126]}, {"name": "Pic Central de Belledone", "alt": 2882, "ll": [45.169201, 5.989321]}, {"name": "la Pyramide", "alt": 2892, "ll": [45.236288, 6.102696]}, {"name": "Dôme des Petites Rousses", "alt": 2807, "ll": [45.127546, 6.104973]}, {"name": "le Toit (Rocher du Lac de Cos)", "alt": 2812, "ll": [45.231826, 6.098823]}, {"name": "Grande Lance d'Allemont", "alt": 2786, "ll": [45.15158, 5.994603]}, {"name": "Pic du Grand Domènon", "alt": 2772, "ll": [45.162114, 5.97114]}, {"name": "Grande Lance de Domène", "alt": 2770, "ll": [45.171648, 5.959351]}, {"name": "Pic Couttet", "alt": 2758, "ll": [45.17076, 5.975244]}, {"name": "Roche Rousse", "alt": 2748, "ll": [45.179361, 5.989177]}, {"name": "le Grand Charnier", "alt": 2745, "ll": [45.155051, 5.99645]}, {"name": "Tête Noire", "alt": 2722, "ll": [45.154769, 5.963609]}, {"name": "Pic des Cabottes", "alt": 2722, "ll": [45.241857, 6.063836]}, {"name": "la Grande Lauzière", "alt": 2720, "ll": [45.157109, 5.958951]}, {"name": "Pic de l'Agnelin", "alt": 2723, "ll": [45.226572, 6.100252]}, {"name": "Pic des Eustaches", "alt": 2711, "ll": [45.21976, 6.091571]}, {"name": "Pic de la Belle Étoile", "alt": 2708, "ll": [45.236935, 6.054022]}, {"name": "Petit Badon", "alt": 2693, "ll": [45.250924, 6.113812]}, {"name": "Roche Noire", "alt": 2682, "ll": [45.183966, 5.9899]}, {"name": "Pic de l'Apparence", "alt": 2683, "ll": [45.2399, 6.058567]}, {"name": "les Trois Officiers", "alt": 2655, "ll": [45.193039, 5.99358]}, {"name": "Villard-Bonnot", "alt": 223, "ll": [45.24267, 5.886479]}], "links": [["https://meteofrance.com/meteo-montagne/belledonne", "Bulletin d'avalanche et météo montagne Belledonne — Météo-France"]]}
};

// massifs made on the device (custom.js), kept with the others
try { Object.assign(SITES, JSON.parse(localStorage.getItem('midi3d-custom-sites') || '{}')); } catch { }
let pick = 'midi';
try { pick = new URLSearchParams(location.search).get('site') || localStorage.getItem('midi3d-site') || 'midi'; } catch { }
export const SITE = SITES[pick] || SITES.midi;
try { localStorage.setItem('midi3d-site', SITE.id); } catch { }
export const SITE_LIST = Object.values(SITES).map(s => ({ id: s.id, name: s.name, region: s.region, alt: s.alt, custom: !!s.custom }));
