# Outdoor → indoor hand-off

How Doorstep's map hands an attendee to the indoor viewer once they reach the
building. Everything is on one site, so there's one link, one domain and HTTPS.

## 1. The event link (organizer's QR code)

```
https://aiatusc-outdoor-nav.doorstepusc.workers.dev/?to=<building>&room=<room id>
```

- `to`: a building id or a name people type. For the demo venue:
  `dr-joseph-medicine-crow-center-for-international-and-public-affairs`,
  or simply `JMC`.
- `room`: the indoor team's room id (e.g. `room_205`). The map doesn't use it.
  It's passed straight through to indoor.
- `anchor` (optional): an indoor place id where indoor directions should start,
  e.g. `left-stair-1`. Without it they start at the door the outdoor route ends
  at. Example: `/?to=JMC&room=258&anchor=left-stair-1`.

## 2. Arrival

The attendee walks the green route. They have **arrived** when either:

- the phone's GPS puts them within **75 m of the venue door** (the route
  recomputes every 15 m, so this triggers automatically), or
- they tap **"I'm at the building"** (GPS is poor next to buildings).

The arrival card shows the building, **"Go in at: <door name>"**, a **photo of
that door** (the "reference view" that confirms the right side), and
**Continue inside →**.

## 3. What indoor receives

`Continue inside` opens:

```
/indoor/?building=<building id>&entrance=<door id>&anchor=<indoor anchor id>&room=<room id>
```

| parameter  | meaning | indoor should |
|------------|---------|---------------|
| `building` | which building | show its map; for a building that is not mapped, say so |
| `entrance` | which outdoor door they came in by | (informational) |
| `anchor`   | **your** start anchor at that door | start the route here, without asking |
| `room`     | destination room from the event link | route to it; ask if missing |

Missing parameters are simply absent. The map's **Indoor View** button opens the
same link (with whatever is known so far), and is hidden once a route shows the
destination has no indoor map.

The viewer is `outdoor-nav/outdoor/static/indoor/` (`index.html`, `nav.mjs`,
`building.json`, `scene/`) and is deployed with the rest of the site. You pick
where you are from pictures of the building, then get steps and a walk preview.

Rooms live in `building.json` under `rooms`: an `id` (what `room=` carries), a
`name`, and either a graph `node` or `floor`, `x`, `z` for the door. Add a
`labels` entry to show the room on the map. Room `258` is there now, at a door
on the second-floor left wing picked from the scan.

`building.json` carries the map's building `id` and `aliases`, so `/indoor/`
can tell a link for another building apart; keep them equal to the entry in §4.
**Use the compressed web scenes** (3–7 MB `.glb`), not the raw 13–22 MB scans.

## 4. The one entry that connects the two halves

`outdoor-nav/data/entrances.override.json`, for the demo venue:

```json
{"building": "dr-joseph-medicine-crow-center-for-international-and-public-affairs",
 "id": "jmc-main",
 "name": "Main entrance (Childs Way)",
 "lat": 0, "lon": 0,
 "indoor_node": "entrance",
 "photo": "/doors/jmc-main.jpg",
 "replace_osm": true,
 "aliases": ["Joseph Medicine Crow Center", "Medicine Crow", "JMC", "Joseph Crow Medicine Building"]}
```

- `lat`/`lon`: **drop a pin standing at the door you scanned.** Don't copy it from a map.
- `indoor_node`: the id of your anchor at that door, so the route starts there.
- `photo`: put the image at `outdoor-nav/outdoor/static/doors/jmc-main.jpg`
  (a phone photo, resized to about 1000 px wide).

After editing: `python outdoor-nav/tools/build_cloudflare_graph.py`, commit
on a branch, open a PR. CI tests it and the merge deploys it.
Until the door is pinned, routes end at the nearest side of the building and
the card says indoor directions aren't set up yet.
