"""Compare actual Python routes with the deployable JavaScript implementation."""
import json
import random
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def compare(expected, actual, path="response"):
    if isinstance(expected, dict):
        assert set(expected) == set(actual), (path, set(expected) ^ set(actual))
        for key in expected:
            compare(expected[key], actual[key], path + "." + key)
    elif isinstance(expected, list):
        assert len(expected) == len(actual), (path, len(expected), len(actual))
        for i, (a, b) in enumerate(zip(expected, actual)):
            compare(a, b, path + "[%d]" % i)
    elif isinstance(expected, float):
        assert abs(expected - actual) <= 1e-7, (path, expected, actual)
    else:
        assert expected == actual, (path, expected, actual)


def main():
    from outdoor.router import WalkGraph, Unreachable
    g = WalkGraph()
    randomizer = random.Random(567)
    base = {"lat": 34.0187, "lon": -118.2905, "building": "Doheny"}
    cases = [base, {**base, "building": "norris"}, {**base, "building": "not-a-real-building"},
             {**base, "lat": None, "lon": None, "place": "royal", "building": "norris theatre"},
             {**base, "stepFree": True},
             {"lat": 34.02108, "lon": -118.28468, "building": "DMC"},
             {"lat": 34.02108, "lon": -118.28468, "building": "DMC", "entrance": "jmc-main"},
             {"lat": 34.02108, "lon": -118.28468, "building": "DMC", "entrance": "not-a-door"},
             {**base, "closures": [{"id": "block", "lat": 34.020, "lon": -118.287, "radius_m": 15}]},
             {**base, "closures": [{"id": "ring", "lat": base["lat"], "lon": base["lon"], "radius_m": 30}]},
             {**base, "reports": [{"id": "report", "lat": base["lat"], "lon": base["lon"], "radius_m": 15, "status": "unverified", "note": "Check"}]}]
    nodes = [point for key, point in g.nodes.items() if not key.startswith('E:')]
    for _ in range(36):
        lat, lon = randomizer.choice(nodes)
        cases.append({"lat": lat, "lon": lon, "building": randomizer.choice(list(g.buildings)),
                      "stepFree": bool(randomizer.randrange(2)),
                      "closures": [{"id": "random", "lat": randomizer.uniform(34.016, 34.025),
                                    "lon": randomizer.uniform(-118.291, -118.28), "radius_m": 15}]})
    expected = []
    for case in cases:
        try:
            result = g.route(case['lat'], case['lon'], case['building'], case.get('closures', []),
                             case.get('reports', []), step_free=case.get('stepFree', False), place=case.get('place'), entrance=case.get('entrance'))
            expected.append({"ok": True, **result})
        except Unreachable as error:
            expected.append({"ok": False, "blocked_by": error.blocked_by, "choices": error.choices})
    result = subprocess.run(["node", str(ROOT/'tools/route_parity.mjs')], input=json.dumps(cases),
                            text=True, capture_output=True, check=True)
    actual = json.loads(result.stdout)
    for index, (old, new) in enumerate(zip(expected, actual)):
        compare(old, new, "case[%d]" % index)
    print("Python/JavaScript full route-response parity: %d cases passed" % len(cases))


if __name__ == '__main__':
    main()
