# Cloudflare mobility release

**AI:** see [AI_SERVICE.md](AI_SERVICE.md). *Ask Doorstep* answers questions only from verified, cited facts and sends the rest to organizers; photo triage suggests what a reported blockage is. Staff approve anything that changes a route.

The current web UI uses the Cloudflare JavaScript API, including driving/parking selection, explicit parked-to-walking continuation, staff vehicle restrictions, and public reports. Start it with `npm run dev` from the repository root. See [UPDATE_EN.md](../UPDATE_EN.md) for setup and limitations.

The Python implementation and API described below are the original walking engine. Its server does not implement the new mobility endpoints.

# outdoor-nav

**Cloudflare / VS Code:** see [../CLOUDFLARE_KO.md](../CLOUDFLARE_KO.md).
The Cloudflare entrypoint is `cloudflare/worker.mjs`; the local server below is unchanged.
The deployed version uses D1 for persistent closures and runs read-only until D1
is connected. It does not implement driving routes or turn-by-turn navigation.

The **far-from-venue** half of the event wayfinding app: walk from wherever you
are on campus to the right door of the venue building, around whatever is
closed right now. At the door it hands off to indoor navigation.

```
pip install -r requirements.txt          # only pytest; the app itself has no deps
python -m pytest -q                      # 17 tests
ADMIN_TOKEN=pick-something python -m outdoor.server     # http://localhost:8100
```

Demo page: `http://localhost:8100/?to=<building-id>&at=<lat>,<lon>`
`at` fakes the start position, because the judges will be indoors and not moving.
Without it, tap the map or press *Use my location*.

Event links (a QR code, or a "Navigate" button in another app):
`/?to=<building id or code>&room=<room>&event=<name>&go=1`. `to` fills the
destination; `go=1` asks for the location straight away and routes as soon as it
arrives (the phone still shows its own "Allow location?" prompt the first time).
Never put anything about the user in the link.

## Why not Google Maps

Google can't route around **your** closures, and the Directions API terms
forbid storing routes or drawing them on a non-Google map. So the paths come
from OpenStreetMap (ODbL, free to store and redistribute with attribution),
and the router is ours. The demo moment: staff mark a path closed, and every
attendee's route bends around it, showing "+N min".

## Trust model (the "when appropriate" in the scenario)

| who posts | status | effect |
|---|---|---|
| anyone | `unverified` | orange dashed circle on the map, warning on routes passing within 30 m. **Does not reroute.** |
| holder of `ADMIN_TOKEN` (transport, DPS, organizer) | `approved` | red circle; routes avoid it and say what it cost |
| admin approves a public report | `approved` | same as above |

Every closure has `starts`/`ends` and lapses on its own (default 4 h), so nobody
has to remember to reopen a gate.

## API

All JSON, CORS open.

`POST /api/outdoor/route`
```json
{"from": {"lat": 34.0187, "lon": -118.2905},
 "to": "edward-l-doheny-junior-memorial-library",
 "step_free": false, "at": "2026-11-15T18:00"}
```
Returns a GeoJSON `FeatureCollection` (feed it straight to Leaflet/Mapbox) with extra keys:
```json
{"ok": true,
 "summary": {"minutes": 18.3, "metres": 1482, "near_venue": false,
             "distance_to_entrance_m": 412, "off_network": false,
             "entrance_source": "osm",
             "avoided":  [{"closure": "be1e354d", "extra_min": 7.8}],
             "warnings": [{"id": "e3214807", "note": "puddle?", "status": "unverified"}]},
 "handoff": {"building": "...", "entrance_id": "osm-n4399697316",
             "entrance_name": "main", "indoor_node": null, "lat": 34.02, "lon": -118.28},
 "features": [ route LineString, start Point, entrance Point ]}
```
On failure: `{"ok": false, "reason": "...: every way in is closed", "blocked_by": ["<closure id>"]}`.

| | |
|---|---|
| `GET /api/buildings?q=` | id, name, centroid, entrance info |
| `GET /api/buildings/<id>` | full record, with outline and entrances |
| `GET /api/closures?at=` | active closures and unverified reports |
| `POST /api/closures` | `{lat, lon, note, radius_m?, starts?, ends?}`. `X-Admin-Token` makes it official |
| `POST /api/closures/<id>/approve` · `/reject` · `DELETE` | admin only |

## Handoff to indoor (agree on this in hours 0–2)

`summary.near_venue` turns true within 75 m of the chosen entrance, and the page
then shows **Continue inside →** linking to `?indoor=<url>` with
`building`, `entrance` and `node` query params. GPS is unreliable next to
buildings, so the indoor side should also offer a manual "I'm at the entrance".

`node` is `indoor_node` from **`data/entrances.override.json`**, the one file
that ties the two halves together. Put the venue's real door there, with the id
of the first node in the indoor team's `graph.json`:

```json
[{"building": "edward-l-doheny-junior-memorial-library", "id": "doheny-main",
  "name": "Main doors (north)", "lat": 34.02028, "lon": -118.28397,
  "indoor_node": "F1_entrance", "replace_osm": true}]
```

Drop the pin yourself, standing at the door. Don't take it from a map. A wrong
door coordinate gives a confident route to the wrong side of the building. An
override can also add a building OSM doesn't know about (include
`building_name`).

## Surveyed data (from field-guide)

`python tools/import_surveyed.py` reads `../field-guide/geo/` and writes
`data/surveyed.json`: 33 hand-surveyed points and the walked Royal → Norris
footpath. It keeps coordinates, kind, names, aliases, structure and access
restrictions, and leaves out notes and open questions.

- **Surveyed doors beat OSM.** Norris theatre, Dedeaux gate, Coliseum Gate 28
  and Ostrow route to the surveyed door (`entrance_source: "surveyed"`).
  Bound-only centroids (Galen) are not used as doors.
- **Start places.** Parking structures (all their walk-out points, so the
  route picks the exit) and campus gates: `from: {"place": "royal"}`.
  Permit-only doors are left out.
- `GET /api/places` lists them.

## Entrance hours

`data/gates.json` is transcribed from Transportation's entrance-hours page.
**These are vehicle hours.** The page says nothing about pedestrians, and a gate
closed to cars can be open on foot (Downey Way on a Saturday). So:

- gate hours **never close a walking path**; only an approved closure does
- `pedestrian.status` is `"not_stated"` unless someone observed it, and then it
  carries the date (`"open"`, observed 2026-11-14, Downey Way)
- `GET /api/gates?at=` returns both. A route from a `place` that has a linked gate
  adds `summary.vehicle_access`, the answer to "can my car get in there right now?"
- holiday hours apply only to dates listed in `holidays`, which the page doesn't provide

Only gates whose surveyed point is clearly the same place are linked
(`place`): Watt and McClintock. The page's gate names and the structure
names don't line up one-to-one; its "Downey Way Entrance" is a campus gate at
Vermont/36th Pl, not the Downey structure.

## Data

`tools/fetch_osm.py` writes `data/walk.json` (3862 nodes, 4490 path segments)
and `data/buildings.json` (184 named buildings). Re-run it for another campus
with `--bbox S,W,N,E`.

Only **10 of 184** buildings have entrances tagged in OSM. For the rest the
route ends at the side of the building nearest a path, with
`entrance_source: "outline"`, and the UI says the door isn't mapped. The
venue should always come from the override file.

## Not built

- Photo uploads of buildings (stretch goal; these could become extra keyframes for the indoor VLM index)
- Recurring pedestrian schedules: nobody publishes them; observed status is one-off
- Waiting out a closure that ends soon: a closed path is treated as removed until it lapses
- Turn-by-turn text: the route is geometry; edges carry OSM street names if you want to add it
