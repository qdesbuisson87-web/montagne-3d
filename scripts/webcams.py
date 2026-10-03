"""Webcams of each massif from OpenStreetMap (Overpass API), copied into data/webcams-<site>.json.

Kept: cameras mapped as webcams (man_made=surveillance + surveillance:type=webcam) and anything with a webcam
link (contact:webcam / webcam), except weather beacons (man_made=monitoring_station: their "webcam" link is a
wind reading). The app shows each one where it stands and opens its own page (the images belong to their owners:
they are not copied). Run by the daily job (.github/workflows/c2c.yml); when Overpass does not answer, the
previous copy is kept. Data © OpenStreetMap contributors, ODbL.
"""
import json, os, sys
from datetime import date
sys.path.insert(0, os.path.dirname(__file__))
from pistes import SITES, overpass  # same boxes, same polite Overpass client


def main(names):
    os.makedirs('data', exist_ok=True)
    for name in names:
        w, s, e, n = SITES[name]
        bb = f'({s},{w},{n},{e})'
        q = f'[out:json][timeout:110];(nwr["surveillance:type"="webcam"]{bb};nwr["contact:webcam"]{bb};nwr["webcam"]{bb};);out tags center;'
        d = overpass(q)
        if not d:
            print(f'{name}: Overpass unreachable, previous copy kept', file=sys.stderr)
            continue
        cams, seen = [], set()
        for el in d.get('elements', []):
            t = el.get('tags', {})
            if t.get('man_made') == 'monitoring_station':
                continue
            url = t.get('contact:webcam') or t.get('webcam') or t.get('website') or t.get('url')
            lat, lon = el.get('lat') or el.get('center', {}).get('lat'), el.get('lon') or el.get('center', {}).get('lon')
            if not url or not url.startswith('http') or lat is None or url in seen:
                continue
            seen.add(url)
            cams.append({'name': t.get('name') or t.get('description') or '', 'lat': round(lat, 6), 'lon': round(lon, 6), 'url': url,
                         'dir': t.get('camera:direction') or t.get('direction')})
        with open(f'data/webcams-{name}.json', 'w', encoding='utf-8') as f:
            json.dump({'fetched': date.today().isoformat(), 'webcams': cams}, f, ensure_ascii=False, separators=(',', ':'))
        print(f'{name}: {len(cams)} webcams')


if __name__ == '__main__':
    main(sys.argv[1:] or list(SITES))
