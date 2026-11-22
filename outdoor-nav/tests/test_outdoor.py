"""A 3x2 grid of paths with a building on the east side, so every answer is
checkable by hand.

    A ---- B ---- C   (C is next to HALL's west door)
    |      |      |
    D ---- E ---- F   (F is next to HALL's south door; E-F is steps)

Lat/lon spacing ~100m. Start is at A.
"""

from datetime import datetime, timedelta

import pytest

from outdoor.closures import ClosureStore
from outdoor.router import Unreachable, WalkGraph
from outdoor.server import App

LAT0, LON0, D = 34.0200, -118.2900, 0.0009       # ~100m in lat, ~83m in lon

P = {"A": (0, 0), "B": (0, 1), "C": (0, 2), "D": (1, 0), "E": (1, 1), "F": (1, 2)}


def ll(name):
    r, c = P[name]
    return LAT0 - r * D, LON0 + c * D


def walk():
    nodes = [{"id": k, "lat": ll(k)[0], "lon": ll(k)[1]} for k in P]
    def e(u, v, s, steps=False):
        return {"u": u, "v": v, "s": s, "m": s * 1.35, **({"steps": True} if steps else {})}
    return {"attribution": "test", "nodes": nodes, "edges": [
        e("A", "B", 60), e("B", "C", 60), e("A", "D", 60),
        e("D", "E", 60), e("E", "F", 60, steps=True),
        e("B", "E", 60), e("C", "F", 60)]}


def buildings():
    c, f = ll("C"), ll("F")
    return {"buildings": [{
        "id": "hall", "name": "Test Hall", "aliases": ["TH"],
        "lat": c[0], "lon": c[1] + 0.0003, "entrance_source": "osm",
        "entrances": [
            {"id": "west", "name": "West door", "lat": c[0], "lon": c[1] + 0.0001},
            {"id": "south", "name": "South door", "lat": f[0] - 0.0001, "lon": f[1]},
        ]}, {
        "id": "annex", "name": "Test Annex", "aliases": [],
        "lat": c[0], "lon": c[1], "entrances": []}]}


@pytest.fixture
def g():
    return WalkGraph(walk(), buildings(), overrides=[])


def start():
    return ll("A")


def test_shortest_route_goes_to_nearest_door(g):
    r = g.route(*start(), "hall")
    assert r["handoff"]["entrance_id"] == "west"
    assert r["summary"]["avoided"] == []
    assert r["summary"]["near_venue"] is False


def test_lookup_by_alias_and_name(g):
    assert g.find_building("th")["id"] == "hall"
    assert g.find_building("Test Hall")["id"] == "hall"
    assert g.find_building("test") is None          # ambiguous: refuse, don't guess


def test_approved_closure_reroutes_and_says_so(g):
    bc = ll("B")
    closure = {"id": "c1", "lat": bc[0], "lon": bc[1] + D / 2, "radius_m": 10,
               "status": "approved"}
    r = g.route(*start(), "hall", closures=[closure])
    assert r["summary"]["avoided"][0]["closure"] == "c1"
    assert r["summary"]["avoided"][0]["extra_min"] > 0
    # B-C is shut: the route must not walk B straight to C
    pts = [tuple(p) for p in r["features"][0]["geometry"]["coordinates"]]
    b, c = (ll("B")[1], ll("B")[0]), (ll("C")[1], ll("C")[0])
    assert (b, c) not in list(zip(pts, pts[1:]))
    assert r["summary"]["minutes"] > g.route(*start(), "hall")["summary"]["minutes"]


def test_unverified_report_warns_but_does_not_reroute(g):
    bc = ll("B")
    report = {"id": "r1", "lat": bc[0], "lon": bc[1] + D / 2, "radius_m": 10,
              "status": "unverified", "note": "fence?"}
    plain = g.route(*start(), "hall")
    r = g.route(*start(), "hall", reports=[report])
    assert r["summary"]["minutes"] == plain["summary"]["minutes"]
    assert [w["id"] for w in r["summary"]["warnings"]] == ["r1"]


def test_step_free_avoids_steps(g):
    # Close B-C and A-B so the only way is down through D-E-F; E-F is steps.
    bc, ab = ll("B"), ll("A")
    shut = [{"id": "x", "lat": bc[0], "lon": bc[1] + D / 2, "radius_m": 10},
            {"id": "y", "lat": ab[0], "lon": ab[1] + D / 2, "radius_m": 10}]
    assert g.route(*start(), "hall", closures=shut)       # walkable with steps
    with pytest.raises(Unreachable) as ei:
        g.route(*start(), "hall", closures=shut, step_free=True)
    assert "x" in ei.value.blocked_by or "y" in ei.value.blocked_by


def test_unreachable_names_the_closure(g):
    a = ll("A")
    ring = {"id": "ring", "lat": a[0], "lon": a[1], "radius_m": 30}
    with pytest.raises(Unreachable) as ei:
        g.route(*start(), "hall", closures=[ring])
    assert ei.value.blocked_by == ["ring"]


def test_building_without_entrances_routes_to_a_labelled_guess():
    b = buildings()
    c = ll("C")
    b["buildings"][1]["outline"] = [[c[0] + 0.0002, c[1]], [c[0] + 0.0002, c[1] + 0.0002],
                                    [c[0] + 0.0004, c[1]], [c[0] + 0.0002, c[1]]]
    g = WalkGraph(walk(), b, overrides=[])
    r = g.route(*start(), "annex")
    assert r["summary"]["entrance_source"] == "outline"
    assert r["handoff"]["entrance_id"] is None


def test_override_entrance_carries_indoor_node():
    c = ll("C")
    ov = [{"building": "hall", "id": "main", "name": "Main doors",
           "lat": c[0], "lon": c[1] + 0.0001, "indoor_node": "F1_entrance",
           "replace_osm": True}]
    g = WalkGraph(walk(), buildings(), overrides=ov)
    r = g.route(*start(), "hall")
    assert r["handoff"]["entrance_id"] == "main"
    assert r["handoff"]["indoor_node"] == "F1_entrance"
    assert r["summary"]["entrance_source"] == "surveyed"
    assert r["handoff"]["indoor_doors"] == []


def test_unlinked_door_names_the_doors_with_indoor_directions():
    c = ll("C")
    ov = [{"building": "hall", "id": "main", "name": "Main doors", "lat": c[0],
           "lon": c[1] + 0.0001, "indoor_node": "F1_entrance", "replace_osm": True},
          {"building": "hall", "id": "side", "name": "Side door", "lat": c[0],
           "lon": c[1] + 0.00005}]
    g = WalkGraph(walk(), buildings(), overrides=ov)
    r = g.route(*start(), "hall")
    assert r["handoff"]["entrance_id"] == "side"      # the nearer door, not linked indoors
    assert r["handoff"]["indoor_node"] is None
    assert r["handoff"]["indoor_doors"] == [{"id": "main", "name": "Main doors"}]


def test_near_venue_flag(g):
    c = ll("C")
    r = g.route(c[0], c[1], "hall")
    assert r["summary"]["near_venue"] is True


# ------------------------------------------------------------- closures/API
def test_closure_windows_and_status(tmp_path):
    s = ClosureStore(tmp_path / "c.json")
    now = datetime(2026, 11, 14, 12, 0)
    pub = s.add(1, 2, "tree down", now=now)
    off = s.add(1, 2, "gate shut", official=True, now=now,
                ends=now + timedelta(hours=1))
    approved, reports = s.split(now)
    assert [c["id"] for c in approved] == [off["id"]]
    assert [c["id"] for c in reports] == [pub["id"]]
    assert s.split(now + timedelta(hours=2))[0] == []       # lapsed on its own
    s.set_status(pub["id"], "approved")
    assert len(ClosureStore(tmp_path / "c.json").split(now)[0]) == 2   # persisted


def test_api_admin_gate(g, tmp_path):
    app = App(g, ClosureStore(tmp_path / "c.json"), admin_token="tok")
    bc = ll("B")
    code, c = app.handle("POST", "/api/closures", {},
                         {"lat": bc[0], "lon": bc[1] + D / 2, "radius_m": 10}, {})
    assert code == 201 and c["status"] == "unverified"
    assert app.handle("POST", "/api/closures/%s/approve" % c["id"], {}, {}, {})[0] == 403
    code, c2 = app.handle("POST", "/api/closures/%s/approve" % c["id"], {}, {},
                          {"X-Admin-Token": "tok"})
    assert code == 200 and c2["status"] == "approved"
    a = ll("A")
    code, r = app.handle("POST", "/api/outdoor/route", {},
                         {"from": {"lat": a[0], "lon": a[1]}, "to": "hall"}, {})
    assert r["ok"] and r["summary"]["avoided"][0]["closure"] == c["id"]


def test_api_bad_input(g, tmp_path):
    app = App(g, ClosureStore(tmp_path / "c.json"), admin_token="")
    assert app.handle("POST", "/api/outdoor/route", {}, {"to": "hall"}, {})[0] == 400
    code, r = app.handle("POST", "/api/outdoor/route", {},
                         {"from": {"lat": 34.02, "lon": -118.29}, "to": "nowhere"}, {})
    assert code == 200 and r["ok"] is False
    # no token configured: nobody is admin, even sending an empty one
    assert app.is_admin({"X-Admin-Token": ""}) is False


def test_shipped_data_loads_and_routes():
    """The real OSM extract: loads, every building is wired, one known route works."""
    g = WalkGraph()
    assert len(g.buildings) > 100
    assert all(g.targets[b] for b in g.buildings)
    r = g.route(34.0187, -118.2905, "Doheny")
    assert 300 < r["summary"]["metres"] < 2000
    assert r["handoff"]["entrance_id"]


# ------------------------------------------------------------------ gates
from outdoor.gates import Gates

GATES = {"holidays": ["2026-11-26"], "gates": [
    {"id": "dw", "name": "Downey Way", "place": None,
     "weekday": [{"from": "06:00", "to": "20:00"}], "weekend": [], "holiday": [],
     "pedestrian": {"status": "open", "observed": "2026-11-14"}},
    {"id": "fig", "name": "Figueroa", "place": "fig",
     "weekday": [{"from": "06:00", "to": "20:00"},
                 {"from": "20:00", "to": "06:00", "access": "usc_id"}],
     "weekend": [{"from": "00:00", "to": "24:00", "access": "usc_id"}], "holiday": []}]}


def test_gate_hours_are_vehicle_hours():
    g = Gates(GATES)
    sat = datetime(2026, 11, 14, 12, 0)
    dw = next(s for s in g.status(sat) if s["id"] == "dw")
    assert dw["vehicle"]["status"] == "closed"          # cars: closed Saturday
    assert dw["pedestrian"]["status"] == "open"          # on foot: observed open
    fig = next(s for s in g.status(datetime(2026, 11, 16, 22, 0)) if s["id"] == "fig")
    assert fig["vehicle"]["status"] == "usc_id"          # wraps midnight
    hol = next(s for s in g.status(datetime(2026, 11, 26, 12, 0)) if s["id"] == "dw")
    assert hol["vehicle"]["column"] == "holiday"


def test_unobserved_pedestrian_status_is_not_stated():
    g = Gates(GATES)
    fig = next(s for s in g.status(datetime(2026, 11, 14, 12, 0)) if s["id"] == "fig")
    assert fig["pedestrian"]["status"] == "not_stated"


def test_closed_vehicle_gate_never_closes_a_walk(g, tmp_path):
    """Gate hours are not closures: the walking route is unchanged by them."""
    app = App(g, ClosureStore(tmp_path / "c.json"), admin_token="", gates=Gates(GATES))
    a = ll("A")
    code, r = app.handle("POST", "/api/outdoor/route", {},
                         {"from": {"lat": a[0], "lon": a[1]}, "to": "hall",
                          "at": "2026-11-14T12:00"}, {})
    assert r["ok"] and r["summary"]["avoided"] == []


def test_real_surveyed_places_and_doors():
    g = WalkGraph()
    if not g.places:
        pytest.skip("no data/surveyed.json")
    # "Norris" is a cinema and a dental school: ask, don't pick
    assert g.find_building("norris") is None
    with pytest.raises(Unreachable) as ei:
        g.route(None, None, "norris", place="royal")
    names = " ".join(c["name"] for c in ei.value.choices)
    assert "Cinema" in names and "Dental" in names
    assert g.find_building("norris theatre")["entrance_source"] == "surveyed"
    r = g.route(None, None, "norris theatre", place="royal")
    assert r["summary"]["start_place"]["id"] == "royal"
    assert not any("permits" in n for n in g.places["mccarthy"]["nodes"])


def test_campus_walks_tagged_cycleway_are_walkable():
    """Childs Way / Watt Way are highway=cycleway + foot=designated. Dropping
    them sent a Downey Way -> Doheny walk round the streets (673m vs 410m)."""
    g = WalkGraph()
    names = {e[5] for e in g.edges}
    assert {"Childs Way", "Watt Way", "Trousdale Parkway"} <= names
    r = g.route(34.02065, -118.28720, "Doheny")
    assert r["summary"]["metres"] < 500


def test_foot_tag_overrides_access():
    import sys
    sys.path.insert(0, "tools")
    from fetch_osm import walkable
    assert walkable({"highway": "cycleway", "foot": "designated", "access": "private"})
    assert not walkable({"highway": "cycleway"})                      # bike-only
    assert not walkable({"highway": "footway", "access": "private"})
    assert not walkable({"highway": "footway", "foot": "no"})


def test_start_on_a_long_footway_does_not_loop():
    """Start on the footway by the Tutor Center: snapping to the nearest NODE
    walked to the footway's far west end and back. Snap to the segment."""
    g = WalkGraph()
    start = (34.01995, -118.28690)
    r = g.route(*start, "Doheny")
    lons = [c[0] for c in r["features"][0]["geometry"]["coordinates"]]
    assert min(lons) > start[1] - 0.0003          # never heads >~30m west
    assert r["summary"]["snap_m"] < 15


def test_segment_snap_is_cleaned_up(g):
    n, e = len(g.nodes), len(g.edges)
    g.route(*start(), "hall")
    assert (len(g.nodes), len(g.edges)) == (n, e)


def test_override_can_add_aliases_and_outline_without_a_door():
    """Venue metadata: names people type, and an outline for the highlight."""
    c = ll("C")
    ov = [{"building": "annex", "aliases": ["The Annex", "TA"],
           "outline": [[c[0], c[1]], [c[0] + 0.0002, c[1]], [c[0] + 0.0002, c[1] + 0.0002]]}]
    g = WalkGraph(walk(), buildings(), overrides=ov)
    b = g.find_building("the annex")
    assert b["id"] == "annex"
    assert b["outline"][0] == b["outline"][-1]          # ring closed
    assert b.get("entrance_source") != "surveyed"        # no door added
    assert g.find_building("nonexistent-override") is None


def test_pedestrian_hours_from_the_gate_schedule():
    g = Gates()                                        # the shipped data
    def ped(gid, when):
        return next(s for s in g.status(when) if s["id"] == gid)["pedestrian"]
    assert ped("downey-way", datetime(2026, 11, 21, 12, 0))["status"] == "closed"   # Saturday
    tue = ped("downey-way", datetime(2026, 11, 17, 12, 0))
    assert tue["status"] == "open" and tue["until"] == "23:00"
    assert ped("downey-way", datetime(2026, 11, 17, 5, 30))["status"] == "varies"
    assert ped("watt", datetime(2026, 11, 21, 3, 0))["status"] == "open"
    assert ped("royal", datetime(2026, 11, 21, 12, 0))["status"] == "not_stated"


def test_avoid_stairs_prefers_a_step_free_door():
    """Surveyed doors carry wheelchair: true/false; avoiding stairs uses a step-free one."""
    g = WalkGraph()
    any_door = g.route(34.0204, -118.2852, "Student Union")
    assert any_door["handoff"]["entrance_id"] in ("su-steps-north", "su-steps-east", "su-ramp")
    level = g.route(34.0204, -118.2852, "Student Union", step_free=True)
    assert level["handoff"]["entrance_id"] == "su-ramp"
    assert level["handoff"]["step_free_door"] is True
