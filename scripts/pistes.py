"""Ski pistes of each massif from OpenStreetMap (Overpass API), copied into data/pistes-<site>.json.

Run by the daily job with the camptocamp copy (.github/workflows/c2c.yml). The public Overpass servers are often
busy: several servers are tried, with waits; when none answers, the previous copy is kept as it is.
Data © OpenStreetMap contributors, ODbL: the app names the source.
"""
import json, os, sys, time, urllib.parse, urllib.request
from datetime import date

SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
UA = 'montagne-3d (https://github.com/qdesbuisson87-web/montagne-3d; daily copy for an offline map app)'
SITES = {  # lon/lat boxes as in scripts/c2c.py
    'midi': [6.65, 45.67, 7.12, 46.085],
    'buet': [6.63, 45.82, 7.10, 46.23],
    'sassiere': [6.69, 45.25, 7.25, 45.71],
}


def overpass(query):
    for attempt in range(6):
        url = SERVERS[attempt % len(SERVERS)]
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': query}).encode(), headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            print('  retry', url, e, file=sys.stderr)
            time.sleep(20 * (attempt + 1))
    return None


def main(names):
    os.makedirs('data', exist_ok=True)
    for name in names:
        w, s, e, n = SITES[name]
        q = f'[out:json][timeout:110];(way["piste:type"]({s},{w},{n},{e});relation["piste:type"]["type"="route"]({s},{w},{n},{e}););out tags geom;'
        d = overpass(q)
        if not d:
            print(f'{name}: Overpass unreachable, previous copy kept', file=sys.stderr)
            continue
        pistes = []
        for el in d.get('elements', []):
            t = el.get('tags', {})
            lines = [el['geometry']] if el['type'] == 'way' and 'geometry' in el else [m['geometry'] for m in el.get('members', []) if m.get('geometry')]
            for g in lines:
                if len(g) < 2:
                    continue
                pistes.append({'type': t.get('piste:type'), 'diff': t.get('piste:difficulty'), 'name': t.get('piste:name') or t.get('name'),
                               'groomed': t.get('piste:grooming'), 'line': [[round(p['lon'], 5), round(p['lat'], 5)] for p in g]})
        with open(f'data/pistes-{name}.json', 'w', encoding='utf-8') as f:
            json.dump({'fetched': date.today().isoformat(), 'source': 'OpenStreetMap (ODbL)', 'pistes': pistes}, f, ensure_ascii=False, separators=(',', ':'))
        print(f'{name}: {len(pistes)} pistes', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:] or list(SITES))
