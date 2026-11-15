"""Compile the unchanged Python walking graph to data for the JS Worker."""
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    from outdoor.router import WalkGraph
    g = WalkGraph()
    cells = {"%d,%d" % key: value for key, value in (g._cells or g._grid()).items()}
    # The real path segments only, as router.py indexed them before wiring
    # doors: what a start point may snap onto.
    seg_cells = {"%d,%d" % key: value for key, value in (g._segs or g._seg_grid()).items()}
    edge_cells = {}
    for index, (u, v, *_rest) in enumerate(g.edges):
        a, b = g.nodes[u], g.nodes[v]
        for i in range(math.floor(min(a[0], b[0]) / .001), math.floor(max(a[0], b[0]) / .001) + 1):
            for j in range(math.floor(min(a[1], b[1]) / .001), math.floor(max(a[1], b[1]) / .001) + 1):
                edge_cells.setdefault("%d,%d" % (i, j), []).append(index)
    latitudes, longitudes = zip(*g.nodes.values())
    data_files = sorted((ROOT / "data").glob("*.json"))
    # Hash with line endings normalised: git checks these files out as CRLF on
    # Windows (core.autocrlf) and LF on Linux CI, and the data is the same.
    sources = {path.name: hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
               for path in data_files if path.name != "closures.json"}
    graph = {"attribution": g.attribution, "nodes": g.nodes, "edges": g.edges,
             "buildings": g.buildings, "places": g.places, "targets": g.targets,
             "out": g.out, "cells": cells, "edgeCells": edge_cells, "segCells": seg_cells,
             "bounds": [min(latitudes), min(longitudes), max(latitudes), max(longitudes)],
             "source_sha256": sources}
    output = ROOT / "cloudflare/graph.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("Compiled original graph: %d nodes, %d directed edges, %d bytes" %
          (len(g.nodes), len(g.edges), output.stat().st_size))


if __name__ == "__main__":
    main()
