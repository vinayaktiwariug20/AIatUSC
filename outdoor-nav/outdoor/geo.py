"""Distances on a campus-sized patch of the earth."""

import math

R_EARTH_M = 6371000.0
WALK_MPS = 1.35          # average adult walking pace; not adjusted for crowds


def haversine_m(a, b):
    """Great-circle metres between (lat, lon) pairs."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * R_EARTH_M * math.asin(math.sqrt(h))


def walk_seconds(metres):
    return metres / WALK_MPS


def point_segment_m(p, a, b):
    """Metres from point p to segment a-b (all (lat, lon)).

    Equirectangular projection around p: exact enough over a few hundred
    metres, and it catches a closure in the MIDDLE of a long OSM segment,
    which an endpoints-only test would miss.
    """
    k = math.cos(math.radians(p[0]))

    def xy(q):
        return ((q[1] - p[1]) * k * 111320.0, (q[0] - p[0]) * 110540.0)

    ax, ay = xy(a)
    bx, by = xy(b)
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(cx, cy)
