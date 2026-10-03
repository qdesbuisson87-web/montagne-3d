"""Snow measured by Météo-France's nivo-meteorological network (mountain stations run with partners, mostly in
winter), copied into data/nivo.json: the latest observation of every station, with its date.

Source: open data "Archive réseau nivo-météorologique" (data.gouv.fr, Licence Ouverte 2.0), one CSV per year
updated every morning (https://meteofrance.s3.sbg.io.cloud.ovh.net/data/OBS/NIVOSE/nivo_<year>.csv.gz). The file
cannot be read by the app itself (no CORS), hence this daily copy (.github/workflows/c2c.yml).
Units in the file: ht_neige and ssfrai in metres, t in kelvin. Nothing is computed here but unit changes.
"""
import csv, gzip, io, json, os, sys, urllib.request
from datetime import date, datetime, timezone

URL = 'https://meteofrance.s3.sbg.io.cloud.ovh.net/data/OBS/NIVOSE/nivo_{}.csv.gz'
UA = 'montagne-3d (https://github.com/qdesbuisson87-web/montagne-3d; daily copy for an offline map app)'


def rows(year):
    try:
        req = urllib.request.Request(URL.format(year), headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            text = gzip.decompress(r.read()).decode('utf-8', 'replace')
        return list(csv.DictReader(io.StringIO(text), delimiter=';'))
    except Exception as e:
        print(f'{year}: {e}', file=sys.stderr)
        return []


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    year = date.today().year
    data = rows(year - 1) + rows(year)  # early in the year the last measures may be in the previous file
    if not data:
        print('no data: previous copy kept', file=sys.stderr)
        return
    last = {}
    for r in data:
        snow = num(r.get('ht_neige'))
        if snow is None or not r.get('validity_time'):
            continue
        key = r.get('geo_id_wigos') or r.get('name')
        if key not in last or r['validity_time'] > last[key]['validity_time']:
            last[key] = r
    stations = []
    for r in last.values():
        t = num(r.get('t'))
        fresh = num(r.get('ssfrai'))
        stations.append({
            'name': r['name'].strip(), 'lat': num(r['lat']), 'lon': num(r['lon']), 'alt': num(r.get('Altitude')),
            'time': r['validity_time'],
            'snow_cm': round(num(r['ht_neige']) * 100),
            'fresh_cm': round(fresh * 100) if fresh is not None else None,
            't_c': round(t - 273.15, 1) if t is not None else None,
        })
    stations.sort(key=lambda s: s['name'])
    os.makedirs('data', exist_ok=True)
    with open('data/nivo.json', 'w', encoding='utf-8') as f:
        json.dump({'fetched': date.today().isoformat(), 'source': 'Météo-France, réseau nivo-météorologique (data.gouv.fr, Licence Ouverte 2.0)', 'stations': stations}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(stations)} stations')


if __name__ == '__main__':
    main()
