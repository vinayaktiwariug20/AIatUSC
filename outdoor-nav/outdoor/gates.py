"""Campus entrance hours.

Vehicle hours come from Transportation's published page. Pedestrian hours come
from Transportation's gate schedule, for the gates it lists (pedestrian_hours).
A gate closed to cars can still be open on foot (Watt Way: 24 hours). So:

  - vehicle status answers "can my car get in?" and nothing else
  - pedestrian status follows pedestrian_hours; DPS opens and closes some gates
    within an hour, shown as "varies"; without hours it is "not_stated" unless
    someone observed it
  - NOTHING here closes a walking path. Only an approved closure does that.
"""

import json
from datetime import datetime
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"


def _mins(t):
    h, m = t.split(":")
    return int(h) * 60 + int(m)


class Gates:
    def __init__(self, blob=None):
        if blob is None:
            p = DATA / "gates.json"
            blob = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        self.source = blob.get("source", "")
        self.pedestrian_source = blob.get("pedestrian_source")
        self.holidays = set(blob.get("holidays", []))
        self.gates = blob.get("gates", [])

    def _column(self, when):
        if when.date().isoformat() in self.holidays:
            return "holiday"
        return "weekend" if when.weekday() >= 5 else "weekday"

    def vehicle(self, gate, when):
        """'open' | 'usc_id' | 'reservation' | 'closed', plus when it next changes."""
        col = self._column(when)
        m = when.hour * 60 + when.minute
        for p in gate.get(col, []):
            lo, hi = _mins(p["from"]), _mins(p["to"])
            inside = lo <= m < hi if lo < hi else (m >= lo or m < hi)
            if inside:
                return {"status": p.get("access", "open"), "until": p["to"],
                        "column": col}
        return {"status": "closed", "column": col}

    def pedestrian(self, gate, when):
        """'open' | 'varies' | 'closed' | 'not_stated', from pedestrian_hours."""
        h = gate.get("pedestrian_hours")
        if not h:
            return gate.get("pedestrian") or {"status": "not_stated"}
        col = self._column(when)
        if not isinstance(h.get(col), list):
            return {"status": "not_stated", "column": col}
        m = when.hour * 60 + when.minute

        def inside(p):
            lo, hi = _mins(p["from"]), _mins(p["to"])
            return lo <= m < hi if lo < hi else (m >= lo or m < hi)
        base = {"column": col, "source": self.pedestrian_source or "USC Transportation gate schedule"}
        for p in h[col]:
            if inside(p):
                return {**base, "status": "open", "until": p["to"]}
        for p in (h.get("uncertain") or {}).get(col, []):
            if inside(p):
                return {**base, "status": "varies", "note": p.get("note"), "until": p["to"]}
        return {**base, "status": "closed"}

    def status(self, when=None):
        when = when or datetime.now()
        out = []
        for g in self.gates:
            ped = self.pedestrian(g, when)
            out.append({"id": g["id"], "name": g["name"], "where": g.get("where"),
                        "place": g.get("place"), "note": g.get("note"),
                        "vehicle": self.vehicle(g, when),
                        "pedestrian": ped})
        return out

    def for_place(self, place_id, when=None):
        return [s for s in self.status(when) if s["place"] == place_id]
