"""Outdoor walking router: start point -> the best entrance of a building,
around whatever is closed right now.

Lifted from field-guide's campus graph and cut down to the one mode a
hackathon needs (walking). What carries over is the part a general-purpose
map cannot do: closures are first-class, every refusal names what is in the
way, and the route says which closure it went around and what that cost.

Closures come from `closures.ClosureStore`. Only APPROVED closures change the
route. Unverified public reports are returned alongside it as warnings and
never re-route anyone on their own say-so.
"""

import heapq
import json
from datetime import datetime
from pathlib import Path

from .geo import haversine_m, point_segment_m, project, walk_seconds

DATA = Path(__file__).resolve().parent.parent / "data"

SNAP_LIMIT_M = 60         # an entrance further than this from any path is not wired in
OFF_NETWORK_M = 150       # a start point further than this is "not on campus yet"
NEAR_VENUE_M = 75         # within this of the chosen entrance: hand off to indoor
REPORT_WARN_M = 30        # unverified reports this close to the route are surfaced


class Unreachable(Exception):
    def __init__(self, reason, blocked_by=()):
        super().__init__(reason)
        self.reason = reason
        self.blocked_by = list(blocked_by)
        self.choices = []


class WalkGraph:
    def __init__(self, walk=None, buildings=None, overrides=None, data_dir=None,
                 surveyed=None):
        d = Path(data_dir) if data_dir else DATA
        walk = walk if walk is not None else _load(d / "walk.json")
        buildings = (buildings if buildings is not None
                     else _load(d / "buildings.json"))
        if overrides is None:
            overrides = _load(d / "entrances.override.json", default=[])
        if surveyed is None:
            surveyed = _load(d / "surveyed.json", default={})

        self.attribution = walk.get("attribution", "")
        self.nodes = {n["id"]: (n["lat"], n["lon"]) for n in walk["nodes"]}
        self.edges = []                    # (u, v, seconds, metres, steps, name)
        for e in walk["edges"]:
            self._add(e["u"], e["v"], e["s"], e.get("m", e["s"] * 1.35),
                      e.get("steps", False), e.get("name", ""))

        self.buildings = {b["id"]: dict(b) for b in buildings.get("buildings", [])}
        self.places = {}                   # start points: "I parked at Royal"
        self._apply_surveyed(surveyed)
        self._apply_overrides(overrides)
        self._wire_entrances()

    def _apply_surveyed(self, s):
        """Hand-surveyed points and walked footpaths (from field-guide).

        Every point is stitched to the nearest OSM path node, and the walked
        segments go in as real edges. Surveyed destinations become doors that
        win over anything OSM guessed; parking exits and campus gates become
        named start places.
        """
        pts = [n for n in s.get("nodes", []) if n.get("lat") is not None]
        if not pts:
            return
        # stitch against OSM only, before the surveyed points join the index
        stitches = [(n, *self.nearest(n["lat"], n["lon"])) for n in pts]
        for n, nid, d in stitches:
            self.nodes["S:" + n["id"]] = (n["lat"], n["lon"])
            if nid is not None and d <= SNAP_LIMIT_M:
                self._add("S:" + n["id"], nid, walk_seconds(d), d)
        for e in s.get("edges", []):
            self._add("S:" + e["u"], "S:" + e["v"], e["s"], e.get("m", e["s"] * 1.35),
                      name="surveyed footpath")
        self._cells = None                  # rebuild the index with them in it

        for n in pts:
            label = n.get("display") or n.get("poi") or n.get("name") or n["id"]
            if n["kind"] == "poi" and not n.get("bound_only"):
                bid = _slug(label)
                door = {"id": n["id"], "lat": n["lat"], "lon": n["lon"],
                        "name": label, "kind": "surveyed"}
                b = self.buildings.get(bid)
                if b is None:
                    b = self.buildings[bid] = {
                        "id": bid, "name": label, "aliases": list(n.get("aliases", [])),
                        "lat": n["lat"], "lon": n["lon"], "entrances": []}
                    if n.get("name") and n["name"].lower() != label.lower():
                        b["aliases"].append(n["name"])
                b["entrances"] = [door]
                b["entrance_source"] = "surveyed"
                b["surveyed"] = True
            elif n.get("restricted_to"):
                continue                    # a permit-only door is not a way out for a guest
            elif n.get("structure") and (n["kind"] == "pedestrian_exit"
                                         or n.get("also_pedestrian")
                                         or n["kind"] == "vehicle_entrance"):
                # people walk out of vehicle entrances too
                p = self.places.setdefault(n["structure"].lower(), {
                    "id": n["structure"].lower(), "kind": "parking",
                    "name": n["structure"].replace("_", " ").title(), "nodes": []})
                p["nodes"].append("S:" + n["id"])
            elif n["kind"] == "campus_gate":
                pid = n["id"].lower()
                self.places[pid] = {"id": pid, "kind": "gate", "name": label,
                                    "nodes": ["S:" + n["id"]]}

    # ------------------------------------------------------------ building
    def _add(self, u, v, s, m, steps=False, name=""):
        self.edges.append((u, v, s, m, steps, name))
        self.edges.append((v, u, s, m, steps, name))

    def _apply_overrides(self, overrides):
        """Hand-placed entrances win over OSM. This is where the venue's real
        door goes -- the same door the indoor graph starts from.

        An entry may also carry building metadata: `aliases` (names people
        actually type), `outline` ([[lat, lon], ...], drawn as the
        highlight), `hours_url` (the owner's hours page, shown as a link) and `part_of`
        (the larger complex people may call it, e.g. Sample Hall in the TCC complex) and
        `building_name` (the correct name when OSM's is wrong; the old one stays searchable as an alias).
        An entry with no lat/lon is metadata only: no door."""
        for o in overrides:
            b = self.buildings.get(o["building"])
            if b is None:
                if "lat" not in o:
                    continue
                b = self.buildings[o["building"]] = {
                    "id": o["building"], "name": o.get("building_name", o["building"]),
                    "aliases": [], "lat": o["lat"], "lon": o["lon"],
                    "entrances": []}
            elif isinstance(o.get("building_name"), str) and o["building_name"].strip() and o["building_name"].strip() != b["name"]:
                b["aliases"] = [b["name"]] + [a for a in b.get("aliases", []) if a != b["name"]]
                b["name"] = o["building_name"].strip()[:120]
            # Ours first: official codes (e.g. TCC) come before OSM's (RTCC), and labels show the first.
            if o.get("aliases"):
                b["aliases"] = list(dict.fromkeys(list(o["aliases"]) + list(b.get("aliases", []))))
            if str(o.get("hours_url", "")).startswith("https://"):
                b["hours_url"] = o["hours_url"]   # a link, never typed-in hours: they change for holidays and game days
            if isinstance(o.get("part_of"), str) and o["part_of"].strip():
                b["part_of"] = o["part_of"].strip()[:80]
            if o.get("outline"):
                ring = [list(map(float, pt)) for pt in o["outline"]]
                b["outline"] = ring if ring[0] == ring[-1] else ring + [ring[0]]
            if "lat" not in o or "id" not in o:
                continue
            if o.get("replace_osm"):
                b["entrances"] = []
            b["entrances"] = [e for e in b["entrances"] if e["id"] != o["id"]]
            b["entrances"].append({k: o.get(k) for k in
                                   ("id", "lat", "lon", "name", "indoor_node",
                                    "wheelchair", "photo")} | {"kind": "surveyed"}
                                  | ({"short_name": o["short_name"]} if o.get("short_name") else {}))
            b["entrance_source"] = "surveyed"

    def _wire_entrances(self):
        """Connect every entrance (or, failing that, every outline vertex) to
        the nearest path node. Outline vertices are a labelled guess: the
        route ends at the side of the building nearest a path, which may not
        be a door."""
        self.targets = {}
        self._index()
        self._segs = None
        for b in self.buildings.values():
            pts = [(e["id"], e["lat"], e["lon"]) for e in b.get("entrances", [])]
            if not pts:
                pts = [("%s:outline%d" % (b["id"], i), lat, lon)
                       for i, (lat, lon) in enumerate(b.get("outline", [])[:-1])]
            ids = []
            for pid, lat, lon in pts:
                key = "E:" + pid
                if self._attach(key, lat, lon, SNAP_LIMIT_M) is not None:
                    ids.append(key)
            self.targets[b["id"]] = ids
        self._index()

    # ------------------------------------------------------------ snapping
    def _seg_grid(self):
        """Path segments by grid cell (every cell their bounding box touches).
        Built once, before doors are wired, so it holds only real paths."""
        g = {}
        for i, (u, v, *_r) in enumerate(self.edges):
            if u > v or u.startswith(("E:", "O:", "P:")) or v.startswith(("E:", "O:", "P:")):
                continue
            (la1, lo1), (la2, lo2) = self.nodes[u], self.nodes[v]
            for ci in range(int(min(la1, la2) // self.CELL), int(max(la1, la2) // self.CELL) + 1):
                for cj in range(int(min(lo1, lo2) // self.CELL), int(max(lo1, lo2) // self.CELL) + 1):
                    g.setdefault((ci, cj), []).append(i)
        return g

    def _snap_edge(self, lat, lon, radius=150):
        """Nearest point on any path SEGMENT (not node): (edge index, metres,
        t along u->v, foot point). Snapping to the nearest node sent a start
        point on a long footway to the far end of it and back."""
        if getattr(self, "_segs", None) is None:
            self._segs = self._seg_grid()
        ci, cj = int(lat // self.CELL), int(lon // self.CELL)
        r = max(1, int(radius / (self.CELL * 92000)) + 1)
        for _grow in range(6):
            best, seen = None, set()
            for i in range(ci - r, ci + r + 1):
                for j in range(cj - r, cj + r + 1):
                    for ei in self._segs.get((i, j), ()):
                        if ei in seen:
                            continue
                        seen.add(ei)
                        u, v = self.edges[ei][0], self.edges[ei][1]
                        d, t, foot = project((lat, lon), self.nodes[u], self.nodes[v])
                        if best is None or d < best[1]:
                            best = (ei, d, t, foot)
            # only trust the answer if nothing outside the searched square could be closer
            if best is not None and best[1] <= r * self.CELL * 92000:
                return best
            r *= 2
        return best

    def _link(self, u, v, s, m, steps=False, name="", live=False):
        for a, b in ((u, v), (v, u)):
            self.edges.append((a, b, s, m, steps, name))
            if live:
                self.out.setdefault(a, []).append(len(self.edges) - 1)

    def _attach(self, key, lat, lon, limit=None, live=False):
        """Put `key` at (lat, lon) and join it to the nearest path segment
        through a foot point P, walkable towards both ends of that segment.
        Returns the perpendicular metres, or None if nothing is within limit."""
        snap = self._snap_edge(lat, lon, radius=limit or 150)
        if snap is None or (limit is not None and snap[1] > limit):
            return None
        ei, d, t, foot = snap
        u, v, sec, m, steps, name = self.edges[ei]
        pk = "P:" + key
        self.nodes[key] = (lat, lon)
        self.nodes[pk] = foot
        self._link(key, pk, walk_seconds(d), d, live=live)
        self._link(pk, u, sec * t, m * t, steps, name, live=live)
        self._link(pk, v, sec * (1 - t), m * (1 - t), steps, name, live=live)
        return d

    def _index(self):
        self.out = {}
        for i, (u, v, *_rest) in enumerate(self.edges):
            self.out.setdefault(u, []).append(i)

    CELL = 0.001            # ~110m of latitude, ~92m of longitude here

    def _grid(self):
        g = {}
        for nid, (lat, lon) in self.nodes.items():
            if not nid.startswith(("E:", "O:", "P:")):
                g.setdefault((int(lat // self.CELL), int(lon // self.CELL)), []).append(nid)
        return g

    def nearest(self, lat, lon):
        """Nearest path node: grid rings outward until no closer cell can exist."""
        if getattr(self, "_cells", None) is None:
            self._cells = self._grid()
        ci, cj = int(lat // self.CELL), int(lon // self.CELL)
        best, bd = None, float("inf")
        for r in range(0, 400):
            # every cell at ring r is at least (r-1) cells away
            if best is not None and (r - 1) * self.CELL * 92000 > bd:
                break
            for i in range(ci - r, ci + r + 1):
                for j in range(cj - r, cj + r + 1):
                    if max(abs(i - ci), abs(j - cj)) != r:
                        continue
                    for nid in self._cells.get((i, j), ()):
                        d = haversine_m((lat, lon), self.nodes[nid])
                        if d < bd:
                            best, bd = nid, d
            if r > 2 and not self._cells:
                break
        return best, bd

    # ------------------------------------------------------------- search
    SAME_PLACE_M = 60       # matches closer than this are one place, not a choice

    def candidates(self, text):
        """Every building the text could mean."""
        t = (text or "").strip().lower()
        if not t:
            return []
        if t in self.buildings:
            return [self.buildings[t]]
        exact = [b for b in self.buildings.values()
                 if t == b["name"].lower()
                 or t in (a.lower() for a in b.get("aliases", []))]
        if exact:
            return exact
        return [b for b in self.buildings.values()
                if t in b["name"].lower()
                or any(t in a.lower() for a in b.get("aliases", []))]

    def find_building(self, text):
        """One building, or None when the text is unknown or ambiguous.

        "Norris" is a cinema theatre and a dental school ~200m apart, on
        opposite errands. A surveyed door only settles a tie when every other
        match is the SAME place (OSM's "Norris Cinema Center" around the
        surveyed theatre door); otherwise the honest answer is a question.
        """
        c = self.candidates(text)
        if len(c) == 1:
            return c[0]
        surveyed = [b for b in c if b.get("surveyed")]
        if len(surveyed) == 1:
            s = surveyed[0]
            if all(haversine_m((s["lat"], s["lon"]), (b["lat"], b["lon"]))
                   <= self.SAME_PLACE_M for b in c):
                return s
        return None

    def find_place(self, text):
        t = (text or "").strip().lower()
        if t in self.places:
            return self.places[t]
        hits = [p for p in self.places.values() if t and t in p["name"].lower()]
        return hits[0] if len(hits) == 1 else None

    def _blocked_edges(self, closures):
        """Edge index -> closure id, for every edge passing within a closure's
        radius."""
        blocked = {}
        for c in closures:
            p, r = (c["lat"], c["lon"]), c.get("radius_m", 15)
            for i, (u, v, *_r) in enumerate(self.edges):
                if i in blocked:
                    continue
                a, b = self.nodes[u], self.nodes[v]
                # cheap reject before the exact test
                if (haversine_m(p, a) > r + 400 and haversine_m(p, b) > r + 400):
                    continue
                if point_segment_m(p, a, b) <= r:
                    blocked[i] = c["id"]
        return blocked

    def _dijkstra(self, src, targets, blocked, step_free):
        targets = set(targets)
        best, prev, pq = {src: 0.0}, {}, [(0.0, src)]
        hit = set()
        while pq:
            cost, n = heapq.heappop(pq)
            if cost > best.get(n, float("inf")):
                continue
            if n in targets:
                path, cur = [n], n
                while cur != src:
                    cur, _i = prev[cur]
                    path.append(cur)
                edges = []
                cur = n
                while cur != src:
                    p, i = prev[cur]
                    edges.append(i)
                    cur = p
                return cost, path[::-1], edges[::-1], hit
            for i in self.out.get(n, []):
                u, v, s, m, steps, name = self.edges[i]
                if i in blocked:
                    hit.add(blocked[i])
                    continue
                if steps and step_free:
                    hit.add("steps")
                    continue
                nc = cost + s
                if nc < best.get(v, float("inf")):
                    best[v], prev[v] = nc, (n, i)
                    heapq.heappush(pq, (nc, v))
        return None, None, None, hit

    def route(self, lat, lon, building, closures=(), reports=(), step_free=False,
              place=None, entrance=None):
        """Returns a GeoJSON FeatureCollection; raises Unreachable.

        `place` (e.g. "royal") starts from every walk-out point of that
        structure at once, so the route picks the exit itself.
        """
        pl = None
        if place is not None:
            pl = place if isinstance(place, dict) else self.find_place(place)
            if pl is None:
                raise Unreachable("unknown place: %r" % (place,))
        b = building if isinstance(building, dict) else self.find_building(building)
        if b is None:
            c = [] if isinstance(building, dict) else self.candidates(building)
            if len(c) > 1:
                e = Unreachable("%r could mean %d places -- which one?"
                                % (building, len(c)))
                e.choices = [{"id": x["id"], "name": x["name"]} for x in c]
                raise e
            raise Unreachable("unknown building: %r" % (building,))
        targets = self.targets.get(b["id"]) or []
        if entrance is not None:
            # One chosen door (e.g. the one where indoor directions start).
            if "E:" + entrance not in targets:
                raise Unreachable("That door does not belong to %s." % b["name"])
            targets = ["E:" + entrance]
        elif step_free:
            # Prefer doors surveyed as step-free (level, ramp or elevator), when there are any.
            ok = {"E:" + e["id"] for e in b.get("entrances", []) if e.get("wheelchair") is True}
            targets = [t for t in targets if t in ok] or targets
        if not targets:
            raise Unreachable("%s has no entrance within %dm of a mapped path"
                              % (b["name"], SNAP_LIMIT_M))

        origin = "O:start"
        base = len(self.edges)
        if pl:
            lat, lon = self.nodes[pl["nodes"][0]]
            self.nodes[origin] = (lat, lon)
            for n in pl["nodes"]:
                self._link(origin, n, 0.0, 0.0, live=True)
            snap_m = 0.0
        else:
            snap_m = self._attach(origin, lat, lon, live=True)
            if snap_m is None:
                raise Unreachable("no mapped path anywhere near the start point")
        try:
            blocked = self._blocked_edges(closures)
            cost, path, eidx, hit = self._dijkstra(origin, targets, blocked,
                                                   step_free)
            if cost is None:
                named = sorted(h for h in hit if h != "steps")
                why = ("every way in is closed" if named
                       else "stairs on every way in" if "steps" in hit
                       else "no path in the map")
                raise Unreachable("%s: %s" % (b["name"], why), named)
            # What would the route have been with nothing closed? The closures
            # on THAT path are the ones this route went around.
            base_cost, base_closures = None, []
            if blocked:
                bc, _bp, beidx, _h = self._dijkstra(origin, targets, {}, step_free)
                if bc is not None:
                    base_cost = bc
                    base_closures = sorted({blocked[i] for i in beidx
                                            if i in blocked})
            metres = sum(self.edges[i][3] for i in eidx)
            if pl:                          # start at the exit actually used
                path = path[1:]
                lat, lon = self.nodes[path[0]]
            coords = [self.nodes[n] for n in path]
        finally:
            touched = {e[0] for e in self.edges[base:]}
            del self.edges[base:]
            for n in touched:
                kept = [i for i in self.out.get(n, []) if i < base]
                if kept:
                    self.out[n] = kept
                else:
                    self.out.pop(n, None)
            for k in (origin, "P:" + origin):
                self.nodes.pop(k, None)

        ent_id = path[-1][2:]
        ent = next((e for e in b.get("entrances", []) if e["id"] == ent_id), None)
        ent_ll = self.nodes[path[-1]]
        to_door = haversine_m((lat, lon), ent_ll)

        avoided = []
        if base_closures:
            extra = round(max(0.0, cost - base_cost) / 60, 1)
            avoided = [{"closure": cid, "extra_min": extra}
                       for cid in base_closures]

        warn = []
        for r in reports:
            p = (r["lat"], r["lon"])
            if any(point_segment_m(p, a, c) <= REPORT_WARN_M + r.get("radius_m", 0)
                   for a, c in zip(coords, coords[1:])):
                warn.append(r)

        def pt(ll, **props):
            return {"type": "Feature", "properties": props,
                    "geometry": {"type": "Point", "coordinates": [ll[1], ll[0]]}}

        return {
            "type": "FeatureCollection",
            "summary": {
                "building": b["id"], "building_name": b["name"],
                "minutes": round(cost / 60, 1), "metres": round(metres),
                "near_venue": to_door <= NEAR_VENUE_M,
                "distance_to_entrance_m": round(to_door),
                "off_network": snap_m > OFF_NETWORK_M,
                "snap_m": round(snap_m),
                "entrance_source": ("outline" if ent is None
                                    else b.get("entrance_source", "osm")),
                "step_free": step_free,
                "start_place": ({"id": pl["id"], "name": pl["name"],
                                 "exit": path[0][2:]} if pl else None),
                "avoided": avoided,
                "warnings": [{"id": r["id"], "note": r.get("note", ""),
                              "status": r["status"]} for r in warn],
            },
            "handoff": {
                "building": b["id"],
                "entrance_id": ent["id"] if ent else None,
                "entrance_name": ent.get("name") if ent else None,
                "indoor_node": ent.get("indoor_node") if ent else None,
                "photo": ent.get("photo") if ent else None,
                "step_free_door": ent.get("wheelchair") if ent else None,
                "lat": ent_ll[0], "lon": ent_ll[1],
                # When this door has no indoor directions, the building's doors that do.
                "indoor_doors": ([] if ent and ent.get("indoor_node") else
                                 [{"id": e["id"], "name": e.get("short_name") or e.get("name") or e["id"]}
                                  for e in b.get("entrances", []) if e.get("indoor_node")]),
            },
            "features": [
                {"type": "Feature",
                 "properties": {"kind": "route", "minutes": round(cost / 60, 1),
                                "metres": round(metres)},
                 "geometry": {"type": "LineString",
                              "coordinates": [[c[1], c[0]] for c in coords]}},
                pt((lat, lon), kind="start"),
                pt(ent_ll, kind="entrance",
                   name=(ent or {}).get("name") or b["name"],
                   guess=ent is None),
            ],
            "attribution": self.attribution,
        }


def _load(path, default=None):
    p = Path(path)
    if not p.exists():
        if default is not None:
            return default
        raise FileNotFoundError("%s missing -- run tools/fetch_osm.py" % p)
    return json.loads(p.read_text(encoding="utf-8"))


def _slug(s):
    out = "".join(c.lower() if c.isalnum() else "-" for c in s)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def parse_when(s):
    return datetime.fromisoformat(s) if s else datetime.now()
