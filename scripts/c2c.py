"""Daily copy of camptocamp.org topos and recent outings for each massif (run by .github/workflows/c2c.yml).

camptocamp.org only answers browsers on its own site (CORS), so the app cannot ask it directly. Once a day this
script asks its public API (politely: one request at a time, half a second apart) and writes data/c2c-<site>.json:
  - routes: every route of the area (title, activities, ratings, height gain, top altitude, aspect, position);
  - outings: those of the last 45 days, with the conditions written by the climbers, and the routes they followed,
    whose drawn line (when camptocamp has one) is kept too.
Content © camptocamp.org contributors, CC BY-SA 4.0: the app names the source and links every route and outing.
"""
import json, math, os, re, sys, time, urllib.request
from datetime import date, timedelta

API = 'https://api.camptocamp.org'
UA = 'montagne-3d (https://github.com/qdesbuisson87-web/montagne-3d; daily copy for an offline map app)'
# lon/lat boxes: each massif's core area widened by ~0.15° (the app's js/sites.js)
SITES = {
    'midi': [6.65, 45.67, 7.12, 46.085],
    'buet': [6.63, 45.82, 7.10, 46.23],
    'sassiere': [6.69, 45.25, 7.25, 45.71],
}
RATINGS = ['global_rating', 'ski_rating', 'labande_global_rating', 'hiking_rating', 'snowshoe_rating', 'rock_free_rating',
           'ice_rating', 'mixed_rating', 'via_ferrata_rating', 'engagement_rating', 'risk_rating', 'exposition_rock_rating']
OUT_DAYS = 45


def get(path):
    for attempt in range(4):
        try:
            req = urllib.request.Request(API + path, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.load(r)
            time.sleep(0.5)
            return data
        except Exception as e:  # busy server, network: wait and try again
            print('  retry', path[:80], e, file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError('camptocamp does not answer: ' + path)


def merc(lon, lat):
    return lon * 20037508.342789244 / 180, math.log(math.tan(math.pi / 4 + lat * math.pi / 360)) * 20037508.342789244 / math.pi


def lonlat(x, y):
    return round(x / 20037508.342789244 * 180, 5), round((2 * math.atan(math.exp(y / 20037508.342789244 * math.pi)) - math.pi / 2) * 180 / math.pi, 5)


def point(doc):
    try:
        g = json.loads(doc['geometry']['geom'])
        return lonlat(*g['coordinates'][:2])
    except Exception:
        return None


def clean(text, n=700):
    if not text:
        return None
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\[\[[^|\]]*\|([^\]]*)\]\]', r'\1', text)      # [[routes/123|name]] -> name
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)            # [text](url) -> text
    text = re.sub(r'[#*_>]+', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:n] + ('…' if len(text) > n else '') if text else None


def title(doc):
    loc = next((l for l in doc.get('locales', []) if l.get('lang') == 'fr'), (doc.get('locales') or [{}])[0])
    t = loc.get('title') or ''
    return f"{loc['title_prefix']} : {t}" if loc.get('title_prefix') else t


def routes_in(bbox):
    x0, y0 = merc(bbox[0], bbox[1]); x1, y1 = merc(bbox[2], bbox[3])
    out, offset = [], 0
    while True:
        page = get(f'/routes?bbox={x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}&pl=fr&limit=100&offset={offset}')
        docs = page.get('documents', [])
        for d in docs:
            p = point(d)
            if not p:
                continue
            r = {'id': d['document_id'], 't': title(d), 'act': d.get('activities') or [], 'll': p,
                 'emax': d.get('elevation_max'), 'dup': d.get('height_diff_up'), 'or': d.get('orientations') or [],
                 'q': d.get('quality'), 'dur': d.get('calculated_duration')}
            r['rt'] = {k: d[k] for k in RATINGS if d.get(k)}
            out.append(r)
        offset += len(docs)
        if not docs or offset >= page.get('total', 0) or offset >= 8000:
            return out


def outings_in(bbox):
    x0, y0 = merc(bbox[0], bbox[1]); x1, y1 = merc(bbox[2], bbox[3])
    cutoff = (date.today() - timedelta(days=OUT_DAYS)).isoformat()
    out, offset = [], 0
    while True:
        page = get(f'/outings?bbox={x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}&pl=fr&limit=100&offset={offset}')
        docs = page.get('documents', [])
        recent = [d for d in docs if (d.get('date_end') or d.get('date_start') or '') >= cutoff]
        for d in recent:
            full = get(f"/outings/{d['document_id']}?l=fr")
            loc = next((l for l in full.get('locales', []) if l.get('lang') == 'fr'), (full.get('locales') or [{}])[0])
            out.append({
                'id': d['document_id'], 't': title(d), 'd': d.get('date_end') or d.get('date_start'), 'act': d.get('activities') or [],
                'c': d.get('condition_rating'), 'emax': d.get('elevation_max'), 'll': point(d), 'by': (d.get('author') or {}).get('name'),
                'routes': [r['document_id'] for r in full.get('associations', {}).get('routes', [])],
                'cond': clean(loc.get('conditions')), 'wx': clean(loc.get('weather'), 200),
                'snow': {k: full.get(k) for k in ('elevation_up_snow', 'elevation_down_snow', 'snow_quality', 'snow_quantity', 'glacier_rating', 'avalanche_signs') if full.get(k)},
            })
        offset += len(docs)
        if not docs or len(recent) < len(docs) or offset >= 1500:  # listed newest first: stop at the first old ones
            return out


def route_line(rid):
    d = get(f'/routes/{rid}?l=fr')
    g = (d.get('geometry') or {}).get('geom_detail')
    if not g:
        return None
    g = json.loads(g)
    lines = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
    pts = [lonlat(*c[:2]) for line in lines for c in line]
    step = max(1, len(pts) // 300)
    return pts[::step] + ([pts[-1]] if len(pts) % step else [])


def main(names):
    os.makedirs('data', exist_ok=True)
    for name in names:
        bbox = SITES[name]
        print('camptocamp', name, file=sys.stderr)
        routes = routes_in(bbox)
        outings = outings_in(bbox)
        # the drawn line of the routes climbed lately (the others are drawn only as a point)
        lines = {}
        for rid in sorted({r for o in outings for r in o['routes']})[:120]:
            try:
                line = route_line(rid)
                if line:
                    lines[str(rid)] = line
            except RuntimeError as e:
                print(' ', e, file=sys.stderr)
        doc = {'fetched': date.today().isoformat(), 'source': 'camptocamp.org (CC BY-SA 4.0)', 'routes': routes, 'outings': outings, 'lines': lines}
        with open(f'data/c2c-{name}.json', 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        print(f'  {len(routes)} routes, {len(outings)} outings, {len(lines)} lines', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:] or list(SITES))
