"""Import hand-surveyed points and footpaths from field-guide.

    python tools/import_surveyed.py                       # ../field-guide/geo
    python tools/import_surveyed.py --geo D:/path/to/geo

Writes data/surveyed.json. Takes what routing uses: coordinates, kind, names,
aliases, which structure a door belongs to, access restrictions, and the
walked footpath segments. Skips free-text notes, open questions, provenance,
and anything with no coordinates. Also skips drive/park edges and the
straight-line "lower bound" edges, which are not paths you can walk.
"""

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEEP = ("id", "kind", "lat", "lon", "name", "display", "aliases", "structure",
        "street", "restricted_to", "also_pedestrian", "bound_only", "poi")
SKIP_KINDS = {"note", "space_group", "poi_superseded", "poi_address"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geo", default=str(ROOT.parent / "field-guide" / "geo"))
    a = ap.parse_args()
    geo = Path(a.geo)
    nodes = json.loads((geo / "nodes.json").read_text(encoding="utf-8"))
    edges = json.loads((geo / "edges.json").read_text(encoding="utf-8"))

    out_nodes = []
    for n in nodes:
        if n.get("kind") in SKIP_KINDS or n.get("lat") is None:
            continue
        keep = {k: n[k] for k in KEEP if n.get(k) is not None}
        # the one fact from a note routing needs: a lot entrance is where cars
        # go in, not a door to walk someone to
        if "lot entrance" in str(n.get("note", "")).lower():
            keep["kind"] = "lot_entrance"
        out_nodes.append(keep)
    ids = {n["id"] for n in out_nodes}
    bound = {n["id"] for n in out_nodes if n.get("bound_only")}

    out_edges, seen = [], set()
    for e in edges:
        if e.get("mode") != "walk" or e["u"] not in ids or e["v"] not in ids:
            continue
        if e["u"] in bound or e["v"] in bound or "LOWER BOUND" in e.get("note", "").upper():
            continue
        key = tuple(sorted((e["u"], e["v"])))
        if key in seen:                     # stored both ways; router adds both
            continue
        seen.add(key)
        m = re.search(r"\((\d+(?:\.\d+)?)m\)", e.get("note", ""))
        out_edges.append({"u": e["u"], "v": e["v"], "s": e["seconds"],
                          "m": float(m.group(1)) if m else round(e["seconds"] * 1.35, 1)})

    dest = ROOT / "data" / "surveyed.json"
    dest.write_text(json.dumps({"source": "on-site survey (field-guide)",
                                "nodes": out_nodes, "edges": out_edges}, indent=1),
                    encoding="utf-8")
    print("%d surveyed points, %d walked segments -> %s"
          % (len(out_nodes), len(out_edges), dest.relative_to(ROOT)))


if __name__ == "__main__":
    main()
