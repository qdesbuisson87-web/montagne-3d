# Montagne 3D

Appli web perso (PWA) qui affiche des massifs en 3D, chargés en direct, avec les conditions réelles.
Le propriétaire parle français et veut le rendu le plus réaliste et détaillé possible. Réponds en français.

## Niveau d'exigence : qualité pro, pas un prototype
Le propriétaire veut un résultat « nickel », de niveau professionnel. Il a de la place disque illimitée et accepte
le temps et les tokens nécessaires. Ne jamais sacrifier la qualité pour aller plus vite.

- **Finir chaque fonctionnalité à fond** avant de passer à la suivante : cas limites, erreurs réseau, absence de données (hors couverture, nuages, hors ligne), états de chargement, textes clairs en français. Pas de « TODO » laissé, pas de demi-fonction.
- **Vérifier soi-même** chaque étape dans le navigateur (vue réelle, console sans erreur, `?debugloop` si l'onglet est caché) et regarder le rendu avant de dire que c'est fini. Dire honnêtement ce qui n'a pas pu être testé (vrai GPU, vrai téléphone, GPS réel).
- **Fluidité** : viser 60 images/s sur un téléphone haut de gamme en qualité Haute, 30 minimum en Extrême. Mesurer (compteur i/s, nombre de tuiles, draw calls) avant/après chaque ajout lourd ; ajouter des niveaux de détail, de l'instanciation et des textures compressées (KTX2) si besoin. Libérer la mémoire GPU des tuiles évincées.
- **Rendu** : pas d'artefacts visibles (jointures de tuiles, clignotements, taches, bords en escalier, textures floues de près). Filtrage soigné (anisotrope, bicubique pour les données basse résolution), transitions progressives entre niveaux de détail.
- **Données** : toujours la meilleure source officielle disponible, avec la date affichée. Ne jamais inventer ni extrapoler une valeur (hauteur de neige, risque d'avalanche) : si une donnée n'existe pas ou n'est pas fiable, le dire dans l'appli.
- **Téléphone d'abord** : gestes tactiles, zones de toucher de 44 px minimum, panneaux utilisables au pouce, encoches et barres système (safe-area), mode paysage, économie de batterie quand l'appli est en arrière-plan.
- **Hors ligne** réellement testé : l'appli s'ouvre et affiche le massif téléchargé sans réseau.
- **Code propre** : modules clairs, un fichier par sujet, noms explicites, pas de code mort, commentaires sur le « pourquoi ». Respecter le style existant.
- **Licences et attributions** à jour dans l'appli (IGN, Copernicus, Météo-France, EOX, Google le cas échéant). Les clés API (Google, Météo-France) sont saisies par le propriétaire, stockées localement, jamais écrites dans le code ni publiées.
- **Mettre à jour ce fichier CLAUDE.md** après chaque étape : ce qui est fait, ce qui a été testé, ce qui reste.

## Lancer
- `lancer.bat` : serveur local `py -3 -m http.server 8765` (Python 3.13 installé par winget, portée utilisateur), puis ouvrir http://localhost:8765/
- Dans Claude Code : `.claude/launch.json` (config « montagne-3d ») pour le navigateur intégré. Le serveur Python laisse le navigateur garder les fichiers en cache : après une modif, `fetch(fichier, {cache:'reload'})` ou vider le cache.
- `?site=midi` ou `?site=sassiere` choisit le massif (mémorisé dans localStorage)
- `?debugloop` : boucle de rendu par setTimeout, pour tester dans un onglet caché (le rAF y est en pause)
- Pas de compilation : modules ES + three.js 0.160 via importmap (cdn.jsdelivr.net)

## Architecture
- `js/sites.js` : un objet par massif (origine, zone chargée, zone « cœur », points météo top/peak2/mid/valley, lieux, téléphérique, liens). Ajouter un sommet = ajouter une entrée.
- `js/geo.js` : Web Mercator (tuiles), repère local en mètres (origine = sommet, x est, z sud, y altitude), Lambert-93 pour l'IGN.
- `js/net.js` : accès réseau des tuiles. Cache Storage d'abord (`midi3d-tiles-v1`, hors ligne), puis file d'attente polie par service (IGN WMS-R, IGN WMTS, Planetary Computer) avec débit adaptatif (AIMD) et nouvelles tentatives sur 429/5xx. `TransientError` = pas de réponse maintenant (hors ligne, refus) : la tuile est retentée plus tard et le parent reste affiché, jamais remplacé par une donnée de repli. Mesuré : le WMS-R IGN refuse (429) au-delà d'environ 40 requêtes en rafale ; avant ce module, 146 tuiles sur 200 retombaient pour de bon sur le relief parent.
- `js/terrain.js` : moteur de streaming en quadtree de tuiles Web Mercator, du zoom 11 au 19, chaque tuile = maillage 64×64 + jupes.
  - chaque tuile charge une grille 67×67 (anneau d'un échantillon au-delà du bord, pris dans la marge de la requête LiDAR, sinon extrapolé) : normales et pentes sans raccord entre tuiles. L'URL LiDAR ne dépend que de la tuile, les caches existants restent valides.
  - texture de pente par tuile (RG16F, gradient du sol en vrais mètres, sans l'exagération), interpolée par pixel. `engine.slopeAt(x, z)` → degrés, orientation, pas de mesure, source du relief (`tile.src` : lidar / rge / global).
  - relief : Terrarium (AWS) jusqu'au z13, puis LiDAR HD IGN (MNT, WMS-R bil float32 en Lambert-93), trous comblés par RGE ALTI puis par la tuile parente. Le MNS est exclu : il contient les câbles de téléphérique.
  - photo : IGN BD ORTHO WMTS (20 cm au z19, pas de z20). Les pixels blancs hors de France sont remplacés par EOX Sentinel-2 cloudless.
  - Cache Storage pour toutes les tuiles (hors ligne), overlays Sentinel-2 : NDSI (neige), SCL (masque nuages).
- `js/live.js` : météo Open-Meteo modèle `meteofrance_seamless` (4 points + prévision à un point/altitude), recherche STAC Planetary Computer en GET (le POST déclenche un preflight CORS refusé), neige par tranche d'altitude, position du soleil.
- `js/app.js` : scène, shaders (neige NDSI filtrée en bicubique et affinée au mètre avec la pente et la photo), ciel, mer de nuages selon la couverture réelle, pluie et neige qui tombent selon la météo à l'altitude visée, fiche d'un point au clic, étiquettes, téléphérique, packs hors ligne, UI.

## Déjà testé et écarté
- « Couleurs du jour » (image Sentinel-2 fusionnée avec la photo) : taches bleues dues à un éclairage différent. Retiré.
- Hauteur de neige au sol des modèles Open-Meteo : incohérente en haute montagne (46 cm à 2 800 m, 0 à 3 842 m). Pas affichée.
- Mélanger les tuiles 3D Google avec l'IGN : interdit par les conditions Google. Un mode Google 3D séparé est possible.

## Feuille de route (le propriétaire veut tout)
Faire dans cet ordre, une étape à la fois, en montrant le résultat avant de passer à la suivante.
Tester chaque étape dans le navigateur (`?debugloop` si l'onglet est caché) et vérifier au moins une vue réelle.

### Phase 1 : l'avoir sur le téléphone
1. **Mise en ligne https** (GitHub Pages, Netlify ou Cloudflare Pages). Le propriétaire crée le compte ; Claude prépare le dépôt et la publication. Vérifier que la PWA s'installe (manifest + sw.js) et que le cache des tuiles marche en https.
   - EN LIGNE (29/09/2026) : https://qdesbuisson87-web.github.io/montagne-3d/ — dépôt public `qdesbuisson87-web/montagne-3d`, GitHub Pages sur `main` (racine). Compte GitHub connecté via `gh auth login --web`. Auteur des commits = adresse noreply GitHub (jamais l'e-mail perso).
   - Publier une mise à jour : `publier.bat` (ou `publier.ps1`, hors dépôt) = commit de tout + push ; Pages se reconstruit en ~1 min. Git : `C:\Program Files\Git\cmd\git.exe`, gh : `C:\Program Files\GitHub CLI\gh.exe` (pas dans le PATH des anciens terminaux).
   - `sw.js` v6 : l'ancien effaçait le cache des tuiles (packs hors ligne) à chaque mise à jour de l'appli ; il garde maintenant les polices en cache et répond hors ligne avec `?site=…`. Penser à augmenter `CACHE` dans sw.js et à y ajouter tout nouveau fichier js.
   - Testé en https (navigateur intégré) : appli chargée sans erreur, service worker actif, manifest servi, cache des tuiles rempli (574 tuiles). Pas encore testé : installation sur un vrai téléphone, ouverture en mode avion.

### Fluidité et roche (29/09/2026, retour du propriétaire : « 3 i/s » sur son téléphone, roche peu réaliste)
- Qualité : Haute par défaut sur écran tactile (avant : Extrême dès 6 Go/8 cœurs, donc ratio ×3 sur téléphone), choix mémorisé (`midi3d-quality`). MSAA seulement si devicePixelRatio < 2.
- Réglage automatique (`adapt`, app.js) : sous l'objectif de la qualité (fps 50/55/30), baisse la résolution (jusqu'à 50 %) puis le détail des tuiles (splitK jusqu'à 60 %) ; remonte après ~6 s confortables. « auto xx % » dans le compteur.
- Nuages : bruit précalculé dans une texture 512² répétable (`cloudNoiseTexture`), 2 lectures au lieu de 48 bruits par pixel ; couches non dessinées si ciel dégagé, 2/3/4 couches selon la qualité. Particules pluie/neige 30/60/100 %.
- Roche : sur les pentes raides, la photo est floutée selon l'étirement 1/cos(pente) (plus de traînées verticales), grain triplanaire (bruit sous rotations, facettes ~11 m et ~2,7 m) en luminosité et en relief simulé (bump par dérivées écran) ; éclairage directionnel type vol IGN en mode Photo sur les faces raides. Essais écartés : fissures sur la ligne médiane du bruit (quadrillage visible), grain fin fort (aspect papier alu).
- Pas mesuré sur un vrai téléphone (le navigateur de test rend en logiciel, ~12 i/s à 100 %). À faire confirmer par le propriétaire.

### Vue Google 3D (étape 12 avancée à la demande du propriétaire, 29/09/2026)
- three.js passé de 0.160 à 0.185.1 (exigé par 3d-tiles-renderer 0.5.3 : three ≥ 0.167). Vue IGN revérifiée après la mise à jour.
- `js/google3d.js` : TilesRenderer + GoogleCloudAuthPlugin (clé du propriétaire, localStorage `midi3d-google-key`), Draco, compression, fondu, ReorientationPlugin (origine du massif, hauteur = géoïde EGM2008 `geoidN` dans sites.js : 53,4 m Midi, 54,8 m Sassière ; groupe tourné de 180° car le plugin met x ouest / z nord).
- Vue exclusive (conditions Google : pas de mélange avec l'IGN) : terrain IGN caché et en pause, pentes / neige du jour / exagération désactivées ; étiquettes, météo, précipitations, nuages, fiche d'un point (rayon sur la surface Google) conservés. Brouillard FogExp2 couleur d'horizon. Textures Google en NoColorSpace (la scène travaille sans gestion des couleurs).
- Attributions des tuiles agrégées et triées en bas de l'écran ; logo Google Maps obligatoire (16–19 px) : fichier `icons/google-maps-logo.png` À AJOUTER (zip officiel « Google_Maps_Attribution_Assets.zip », demander l'accord du propriétaire pour le téléchargement) ; en attendant le texte « Google ».
- Tarifs vérifiés (pages Google, 29/09/2026) : facturé à la requête « root tileset » (= une session de 3 h), 1 000 gratuites / mois puis 6 $ / 1 000 ; quota max 10 000 / jour, réglable plus bas par le propriétaire.
- Testé avec la clé du propriétaire (en ligne, navigateur intégré) : rendu OK (vraie roche, station du Midi), couleurs justes, attributions affichées (« Google ; Airbus ; Data SIO… »), ~49 i/s dans le navigateur de test. Hauteur Google au sommet du Midi 3 836 m (officiel 3 842) : calage géoïde correct à quelques mètres. Clé refusée → `whyRefused()` donne la raison de Google en français (ex. SERVICE_DISABLED = API pas activée ; l'activation met quelques minutes à prendre effet).
- Logo officiel : `icons/google-maps-logo.svg` (version « WithLightOutline » du zip officiel Google_Maps_Attribution_Assets, téléchargé avec l'accord du propriétaire), 16 px.
- Reste : aller-retour IGN ↔ Google sans nouvelle session (garder le TilesRenderer caché au lieu de le détruire), test sur téléphone.

### Navigation libre (29/09/2026, demande : « naviguer sur la carte, pas que de sommet en sommet »)
- Gestes type Google Earth : 1 doigt / clic gauche = glisser la carte, 2 doigts = zoom + rotation/inclinaison, clic droit = tourner. Le pivot (controls.target) glisse sur le sol après un déplacement (IGN : heightAt ; Google : rayon vertical toutes les 6 images), caméra décalée d'autant.
- Carte sans limite : `engine.ensureRoots(x, z, 45 km)` toutes les 60 images crée les tuiles z11 autour de la vue et libère celles au-delà de 72 km. Hors de la zone du massif (> 30 km de l'origine), la météo en direct (précipitations, mer de nuages) est masquée avec un message, car les stations ne décrivent que le massif.
- Recherche (`js/search.js`) : IGN Géoplateforme (index poi, biaisé vers la vue) + Nominatim OSM (viewbox, uniquement à la validation, conforme à sa charte). Classement : nom correspondant d'abord, éléments de montagne (catégorie seulement) avant quartiers/lieux-dits, puis distance ; distance affichée. Testé : Grand Paradis, lac Blanc, Tignes, Cervin, refuge du Goûter → bon premier résultat. Vol vers le lieu + épingle.
- Remarque : repère local Web Mercator à l'échelle de l'origine, déformation ~1,8 % à 100 km (visuel seulement ; pentes corrigées par tuile).

### Phase 2 : préparer une sortie
2. **Carte des pentes** : FAIT (29/09/2026). Case « Pentes (27° et plus) » dans Affichage (mémorisée), légende sous le titre, classes dans `SLOPE_CLASSES` (app.js) partagées par le shader et la légende. Pente par pixel depuis la texture de gradient de la tuile, bords de classes lissés sur ~1 pixel (fwidth). Pente et orientation affichées au survol et dans la fiche d'un point, avec le pas de mesure et la vraie source du relief. Testé dans le navigateur intégré (vue large, vue proche sans raccord, format téléphone 375×812, fiche d'un point). Pas testé : vrai GPU de téléphone (coût du shader : 1 lecture de texture de plus, seulement quand la carte est affichée).
   - Au passage : sur téléphone, le bloc altitude/coordonnées passe en bas au-dessus des onglets (il recouvrait le titre).
3. **Position GPS** (« Tu es ici ») : `navigator.geolocation.watchPosition`, marqueur 3D + cercle de précision, bouton « Me centrer ». Https obligatoire.
4. **Traces GPX** : import de fichier (input file) → polyligne drapée sur le relief (heightAt), profil d'altitude en SVG, D+/D−, distance, pente maxi, temps estimé (règle de Munter ou DIN 33466). Export GPX d'un tracé dessiné au doigt.
5. **Risque d'avalanche (BERA)** : API Météo-France (clé gratuite du propriétaire, saisie dans l'app et stockée en localStorage). Afficher le niveau par massif et par altitude, avec la date et un lien vers le bulletin complet. Même clé pour la **hauteur de neige mesurée** des stations nivologiques les plus proches (altitude et date affichées).
6. **Isotherme 0 °C et vent** : plan semi-transparent à l'altitude du gel (freezing_level_height) ; flèches ou particules de vent sur les crêtes (vent à l'altitude via Open-Meteo `wind_speed_700hPa`/`wind_direction_700hPa`, ou vent des points météo).

### Phase 3 : réalisme
7. **Forêts 3D** : couche IGN hauteur de végétation (`IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93`, WMS-R). Pour les tuiles z≥16 : échantillonner le MNH, placer des arbres (InstancedMesh, 2–3 modèles de conifères low-poly + billboards au loin) là où la hauteur est >3 m, taille = hauteur mesurée, couleur tirée de la photo. Limiter le nombre d'instances selon la qualité.
8. **Bâtiments 3D** : IGN BD TOPO bâtiments (WFS Géoplateforme, `BDTOPO_V3:batiment`, champ `hauteur`) extrudés, toits teintés depuis la photo. Chamonix, Tignes, Val-d'Isère, stations du téléphérique.
9. **Ombres portées réelles** (mode Soleil) : carte d'horizon ou shadow map en cascade sur les tuiles proches ; curseur d'heure et de date (« quand cette face prend-elle le soleil ? »).
10. **Lacs** : polygones hydro BD TOPO (`BDTOPO_V3:plan_d_eau`) → surface d'eau avec reflet du ciel et vaguelettes animées.
11. **Nuage de points LiDAR HD** (COPC, ~30 cm) : d'abord le sommet de l'Aiguille du Midi (~4 km², ~0,5–1 Go), puis le massif (15–50 Go). Conversion (PotreeConverter ou py3dtiles), affichage LOD fusionné avec le terrain de près. Stockage hors OneDrive, 50–100 Go libres ; en ligne, il faut un stockage objet (Cloudflare R2 ou équivalent).
12. **Mode Google Photorealistic 3D Tiles**, séparé (pas de mélange avec l'IGN, conditions Google), avec la clé du propriétaire qu'il saisit lui-même ; bascule en gardant le point de vue ; nos surcouches (étiquettes, météo, fiche point, précipitations) restent affichées.

### Phase 4 : découverte
13. **Mode viseur (type PeakFinder)** : `DeviceOrientationEvent` + GPS → caméra à la position et dans la direction du téléphone, noms des sommets visibles (occlusion par le relief). Permission iOS à demander sur un geste.
14. **Film de l'enneigement** : liste des passages Sentinel-2 sans nuages des 6–12 derniers mois (STAC), animation de la neige NDSI date par date, avec un curseur de date.
15. **Webcams et vues 360°** : marqueurs cliquables (webcams officielles en lien, photos 360° Panoramax/Mapillary en aperçu quand la licence le permet).
16. **Plus de sommets** dans `js/sites.js` (coordonnées via Wikidata P625, altitude officielle IGN, vérifier la couverture LiDAR avant).

## Contraintes
- Ne rien mettre sur le PC ou le OneDrive professionnels du propriétaire.
- Afficher la date de chaque donnée (satellite, météo) et ne jamais présenter l'appli comme un remplaçant du bulletin d'avalanche.
