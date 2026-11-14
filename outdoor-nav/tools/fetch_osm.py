"""Fetch the campus walking network, named buildings and their entrances
from OpenStreetMap (ODbL -- free to store and redistribute with attribution).

    python tools/fetch_osm.py                      # USC University Park bbox
    python tools/fetch_osm.py --bbox S,W,N,E       # anywhere else

Writes data/walk.json and data/buildings.json. Nothing in here is surveyed by
hand: entrances come from OSM `entrance=*` tags. A building with no tagged
entrance gets `entrance_source: "outline"` -- routed to the nearest path point
on its outline, and labelled as a guess. Fix the venue by hand in
data/entrances.override.json (see README).
"""

import argparse
import json
import math
import ssl
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from outdoor.geo import haversine_m, walk_seconds      # noqa: E402

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
USC_BBOX = (34.0150, -118.2930, 34.0270, -118.2780)
ATTRIBUTION = ("Map data from OpenStreetMap contributors, ODbL 1.0 "
               "(https://www.openstreetmap.org/copyright)")

# cycleway is in here on purpose: USC's main walks (Childs Way, Watt Way, most
# of Trousdale) are tagged highway=cycleway + foot=designated -- shared malls,
# drawn blue-dashed on the OSM map. Leaving cycleway out dropped them and sent
# people round the outside of campus on the streets.
WALKABLE = ("footway|path|pedestrian|steps|living_street|corridor|cycleway"
            "|residential|tertiary|secondary|primary|unclassified|service")

# Fetch broadly; who may walk it is decided in walkable() below, because
# Overpass filters cannot express "foot= overrides access=".
Q_WALK = ('[out:json][timeout:90];('
          'way({bbox})["highway"~"^(' + WALKABLE + ')$"];'
          ');out geom;')

FOOT_OK = {"yes", "designated", "permissive"}


def walkable(tags):
    """OSM access rules for a pedestrian: an explicit foot= tag wins over the
    general access= tag (campus walks are often access=private, foot=designated)."""
    foot = tags.get("foot")
    if foot == "no":
        return False
    if foot in FOOT_OK:
        return True
    if tags.get("highway") == "cycleway":
        return False      # bike-only unless foot is stated
    return tags.get("access") not in ("private", "no")
Q_BUILDINGS = ('[out:json][timeout:90];('
               'way({bbox})["building"]["name"];'
               'relation({bbox})["building"]["name"]["type"="multipolygon"];'
               'node({bbox})["entrance"];'
               ');out geom;')


def _context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def fetch(query, bbox):
    q = query.replace("{bbox}", ",".join(str(x) for x in bbox))
    qs = urllib.parse.urlencode({"data": q})
    last = None
    for base in ENDPOINTS:
        req = urllib.request.Request(base + "?" + qs, headers={
            "User-Agent": "outdoor-nav/0.1 (campus wayfinding prototype)",
            "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180, context=_context()) as r:
                print("  via " + urllib.parse.urlparse(base).netloc)
                return json.load(r)
        except Exception as e:                       # noqa: BLE001
            last = e
            print("  %s: %s %s" % (urllib.parse.urlparse(base).netloc,
                                   type(e).__name__, str(e)[:60]))
    raise SystemExit("every Overpass mirror failed; last error: %s" % last)


def build_walk(payload):
    """OSM ways -> nodes keyed by rounded coordinate, plus undirected edges.

    `out geom` gives coordinates, not shared node ids, so the coordinate is
    the join key (7 dp is ~1cm).
    """
    nodes, edges, seen = {}, [], set()

    def key(p):
        return "%.7f,%.7f" % (p["lat"], p["lon"])

    for w in payload.get("elements", []):
        geom, tags = w.get("geometry") or [], w.get("tags") or {}
        if not walkable(tags):
            continue
        for p in geom:
            k = key(p)
            if k not in nodes:
                nodes[k] = {"id": "w%d" % len(nodes),
                            "lat": round(p["lat"], 7), "lon": round(p["lon"], 7)}
        for a, b in zip(geom, geom[1:]):
            ka, kb = key(a), key(b)
            if ka == kb or (ka, kb) in seen or (kb, ka) in seen:
                continue
            seen.add((ka, kb))
            m = haversine_m((a["lat"], a["lon"]), (b["lat"], b["lon"]))
            steps = tags.get("highway") == "steps"
            e = {"u": nodes[ka]["id"], "v": nodes[kb]["id"],
                 "m": round(m, 1),
                 "s": round(walk_seconds(m) * (1.8 if steps else 1.0), 1),
                 "way": w.get("id")}
            if steps:
                e["steps"] = True
            if tags.get("name"):
                e["name"] = tags["name"]
            edges.append(e)
    return list(nodes.values()), edges


def _centroid(geom):
    lat = sum(p["lat"] for p in geom) / len(geom)
    lon = sum(p["lon"] for p in geom) / len(geom)
    return round(lat, 7), round(lon, 7)


def _slug(s):
    out = "".join(c.lower() if c.isalnum() else "-" for c in s)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def build_buildings(payload):
    """Named buildings, each with the OSM entrances that sit on its outline."""
    els = payload.get("elements", [])
    ents = [e for e in els if e["type"] == "node"]
    out, used = [], set()
    for w in els:
        if w["type"] == "way":
            geom = w.get("geometry") or []
        elif w["type"] == "relation":
            # multipolygon (e.g. Doheny Library): its outer rings, joined
            geom = [p for m in w.get("members", []) if m.get("role") == "outer"
                    for p in (m.get("geometry") or [])]
        else:
            continue
        tags = w.get("tags") or {}
        if len(geom) < 3:
            continue
        verts = {"%.7f,%.7f" % (p["lat"], p["lon"]) for p in geom}
        mine = []
        for n in ents:
            if "%.7f,%.7f" % (n["lat"], n["lon"]) in verts:
                t = n.get("tags") or {}
                mine.append({
                    "id": "osm-n%d" % n["id"],
                    "lat": n["lat"], "lon": n["lon"],
                    "name": t.get("name") or t.get("ref") or t.get("entrance"),
                    "kind": t.get("entrance"),
                    "wheelchair": t.get("wheelchair")})
        bid = _slug(tags.get("short_name") or tags["name"])
        base, i = bid, 2
        while bid in used:
            bid, i = "%s-%d" % (base, i), i + 1
        used.add(bid)
        lat, lon = _centroid(geom[:-1] if geom[0] == geom[-1] else geom)
        aliases = [tags[k] for k in ("short_name", "alt_name", "official_name")
                   if tags.get(k)]
        out.append({
            "id": bid, "name": tags["name"], "aliases": aliases,
            "lat": lat, "lon": lon, "osm": "%s/%d" % (w["type"], w["id"]),
            "outline": [[round(p["lat"], 6), round(p["lon"], 6)] for p in geom],
            "entrances": mine,
            "entrance_source": "osm" if mine else "outline"})
    out.sort(key=lambda b: b["name"].lower())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", help="S,W,N,E (default: USC University Park)")
    ap.add_argument("--out", default=str(ROOT / "data"))
    a = ap.parse_args()
    bbox = tuple(float(x) for x in a.bbox.split(",")) if a.bbox else USC_BBOX
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    print("walk network ...")
    nodes, edges = build_walk(fetch(Q_WALK, bbox))
    # A busy mirror can answer 200 with nothing in it. Never overwrite good
    # data with an empty network.
    if len(nodes) < 100:
        raise SystemExit("only %d walk nodes came back -- mirror problem? "
                         "data/ left unchanged" % len(nodes))
    print("  %d nodes, %d edges" % (len(nodes), len(edges)))

    print("buildings and entrances ...")
    blds = build_buildings(fetch(Q_BUILDINGS, bbox))
    if not blds:
        raise SystemExit("no buildings came back -- data/buildings.json left unchanged")
    (out / "walk.json").write_text(json.dumps(
        {"attribution": ATTRIBUTION, "bbox": bbox, "nodes": nodes, "edges": edges},
        separators=(",", ":")), encoding="utf-8")
    (out / "buildings.json").write_text(json.dumps(
        {"attribution": ATTRIBUTION, "bbox": bbox, "buildings": blds},
        separators=(",", ":")), encoding="utf-8")
    tagged = sum(1 for b in blds if b["entrances"])
    print("  %d named buildings, %d with tagged entrances" % (len(blds), tagged))


if __name__ == "__main__":
    main()
