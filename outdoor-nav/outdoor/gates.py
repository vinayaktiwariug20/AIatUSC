"""Campus entrance hours, from Transportation's published page.

These are VEHICLE hours. The source says nothing about people on foot, and a
gate closed to cars is often open to pedestrians (Downey Way, Saturday). So:

  - vehicle status answers "can my car get in?" and nothing else
  - pedestrian status is "not_stated" unless someone observed it
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

    def status(self, when=None):
        when = when or datetime.now()
        out = []
        for g in self.gates:
            ped = g.get("pedestrian") or {"status": "not_stated"}
            out.append({"id": g["id"], "name": g["name"], "where": g.get("where"),
                        "place": g.get("place"), "note": g.get("note"),
                        "vehicle": self.vehicle(g, when),
                        "pedestrian": ped})
        return out

    def for_place(self, place_id, when=None):
        return [s for s in self.status(when) if s["place"] == place_id]
