"""Dependency-free JSON API + the demo map page.

    python -m outdoor.server                 # http://localhost:8100
    ADMIN_TOKEN=secret python -m outdoor.server --port 8100

Endpoints (all JSON, CORS open so the Next.js app can call it directly):

    GET  /api/buildings?q=text          list (id, name, lat, lon, entrance info)
    GET  /api/buildings/<id>            one, with outline and entrances
    GET  /api/places                    named start points (parking structures, gates)
    GET  /api/gates?at=ISO              entrance VEHICLE hours now; pedestrian status
                                        only where observed, else "not_stated"
    POST /api/outdoor/route             {from:{lat,lon} | {place:"royal"}, to:"<building id or name>",
                                         at?: ISO time, step_free?: bool}
    GET  /api/closures?at=ISO           active closures + unverified reports
    POST /api/closures                  {lat, lon, note, radius_m?, starts?, ends?}
                                        with X-Admin-Token -> official/approved,
                                        without            -> public/unverified
    POST /api/closures/<id>/approve     admin only
    POST /api/closures/<id>/reject      admin only
    DELETE /api/closures/<id>           admin only
"""

import argparse
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .closures import ClosureStore
from .gates import Gates
from .router import DATA, Unreachable, WalkGraph, parse_when

STATIC = Path(__file__).resolve().parent / "static"


class App:
    def __init__(self, graph=None, store=None, admin_token=None, gates=None):
        self.graph = graph or WalkGraph()
        self.gates = gates if gates is not None else Gates()
        self.store = store or ClosureStore(DATA / "closures.json")
        self._route_lock = threading.Lock()   # route() splices a temp origin into the graph
        self.admin_token = admin_token if admin_token is not None else os.environ.get("ADMIN_TOKEN", "")

    def is_admin(self, headers):
        return bool(self.admin_token) and headers.get("X-Admin-Token") == self.admin_token

    # Returns (status, body). Pure, so tests do not need a socket.
    def handle(self, method, path, query, body, headers):
        g = self.graph
        if method == "GET" and path == "/api/buildings":
            q = (query.get("q", [""])[0] or "").lower()
            rows = [{"id": b["id"], "name": b["name"], "lat": b["lat"], "lon": b["lon"],
                     "entrance_source": b.get("entrance_source"),
                     "entrances": len(b.get("entrances", [])),
                     "hours_url": b.get("hours_url"), "part_of": b.get("part_of")}
                    for b in g.buildings.values()
                    if not q or q in b["name"].lower()
                    or any(q in a.lower() for a in b.get("aliases", []))]
            return 200, sorted(rows, key=lambda r: r["name"].lower())

        if method == "GET" and path == "/api/gates":
            return 200, {"source": self.gates.source,
                         "scope": "vehicle hours; pedestrian access is not stated by the source",
                         "gates": self.gates.status(parse_when(query.get("at", [None])[0]))}

        if method == "GET" and path == "/api/places":
            def walk_out(p):   # where people leave on foot: the first pedestrian exit, else the first point
                n = next((x for x in p["nodes"] if ".ped." in x), p["nodes"][0])
                ll = g.nodes.get(n)
                return (ll[0], ll[1]) if ll else (None, None)
            return 200, [{"id": p["id"], "name": p["name"], "kind": p["kind"],
                          "lat": walk_out(p)[0], "lon": walk_out(p)[1]}
                         for p in sorted(g.places.values(), key=lambda p: p["name"])]

        m = re.fullmatch(r"/api/buildings/([^/]+)", path)
        if method == "GET" and m:
            b = g.buildings.get(m.group(1))
            return (200, b) if b else (404, {"error": "no such building"})

        if method == "POST" and path == "/api/outdoor/route":
            try:
                frm, to = body["from"], body["to"]
                place = frm.get("place")
                lat, lon = ((None, None) if place
                            else (float(frm["lat"]), float(frm["lon"])))
            except (KeyError, TypeError, ValueError, AttributeError):
                return 400, {"error": "need from:{lat,lon} or from:{place} and to"}
            when = parse_when(body.get("at"))
            closures, reports = self.store.split(when)
            try:
                with self._route_lock:
                    out = g.route(
                        lat, lon, to, closures, reports,
                        step_free=bool(body.get("step_free")), place=place,
                        entrance=body.get("entrance") if isinstance(body.get("entrance"), str) else None)
                sp = out["summary"].get("start_place")
                if sp:
                    # vehicle hours for the gate at this place: can the car get in?
                    out["summary"]["vehicle_access"] = self.gates.for_place(sp["id"], when)
                return 200, {"ok": True, **out}
            except Unreachable as e:
                return 200, {"ok": False, "reason": e.reason,
                             "blocked_by": e.blocked_by, "choices": e.choices}

        if method == "GET" and path == "/api/closures":
            when = parse_when(query.get("at", [None])[0])
            return 200, self.store.active(when)

        if method == "POST" and path == "/api/closures":
            try:
                c = self.store.add(body["lat"], body["lon"], body.get("note", ""),
                                   body.get("radius_m", 15),
                                   official=self.is_admin(headers),
                                   starts=body.get("starts"), ends=body.get("ends"),
                                   kind=body.get("kind", "blockage"))
            except (KeyError, TypeError, ValueError) as e:
                return 400, {"error": str(e)}
            return 201, c

        m = re.fullmatch(r"/api/closures/([0-9a-f]+)(?:/(approve|reject))?", path)
        if m and method in ("POST", "DELETE"):
            if not self.is_admin(headers):
                return 403, {"error": "admin token required"}
            cid, act = m.groups()
            if method == "DELETE":
                return (200, {"deleted": cid}) if self.store.delete(cid) else (404, {"error": "not found"})
            if act:
                c = self.store.set_status(cid, "approved" if act == "approve" else "rejected")
                return (200, c) if c else (404, {"error": "not found"})

        return 404, {"error": "not found"}


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self._send(204, b"")

        def _dispatch(self, method):
            u = urlparse(self.path)
            if method == "GET" and not u.path.startswith("/api/"):
                f = STATIC / ("index.html" if u.path in ("/", "") else u.path.lstrip("/"))
                if f.resolve().is_relative_to(STATIC.resolve()) and f.is_file():
                    ct = {"html": "text/html", "js": "text/javascript",
                          "css": "text/css"}.get(f.suffix[1:], "application/octet-stream")
                    return self._send(200, f.read_bytes(), ct + "; charset=utf-8")
                return self._send(404, {"error": "not found"})
            body = {}
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                try:
                    body = json.loads(self.rfile.read(n))
                except ValueError:
                    return self._send(400, {"error": "bad json"})
            code, out = app.handle(method, u.path, parse_qs(u.query), body, self.headers)
            self._send(code, out)

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def log_message(self, fmt, *a):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8100)
    a = ap.parse_args()
    app = App()
    print("loaded %d path nodes, %d buildings" % (len(app.graph.nodes), len(app.graph.buildings)))
    if not app.admin_token:
        print("ADMIN_TOKEN not set: nobody can post official closures or approve reports")
    print("http://localhost:%d" % a.port)
    ThreadingHTTPServer((a.host, a.port), make_handler(app)).serve_forever()


if __name__ == "__main__":
    main()
