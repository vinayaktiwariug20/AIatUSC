"""Closures and incident reports.

One record type, two trust levels:

  official    posted by someone holding the admin token (transportation,
              DPS, the event organiser). Status "approved" on arrival.
  public      anyone with the page. Status "unverified" on arrival. Shown on
              the map and as a warning on any route passing near it, but it
              does NOT change anyone's route until an admin approves it.

Who said it decides what it may do. A single unverified report re-routing
every attendee is the failure mode this exists to prevent.

Every closure has a time window; an expired one simply stops applying, so
"Gate 3 closed until 18:00" needs no one to remember to reopen it.
"""

import json
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path

DEFAULT_HOURS = 4          # a report with no end time lapses after this


class ClosureStore:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self._lock = threading.Lock()
        self.items = []
        if self.path and self.path.exists():
            self.items = json.loads(self.path.read_text(encoding="utf-8"))

    def _save(self):
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.items, indent=1), encoding="utf-8")

    def add(self, lat, lon, note="", radius_m=15, official=False,
            starts=None, ends=None, now=None, kind="blockage"):
        now = now or datetime.now()
        starts = _dt(starts) or now
        ends = _dt(ends) or (starts + timedelta(hours=DEFAULT_HOURS))
        if ends <= starts:
            raise ValueError("ends must be after starts")
        if not (0 < float(radius_m) <= 200):
            raise ValueError("radius_m must be in (0, 200]")
        c = {"id": uuid.uuid4().hex[:8], "kind": kind,
             "lat": float(lat), "lon": float(lon), "radius_m": float(radius_m),
             "note": str(note)[:280],
             "source": "official" if official else "public",
             "status": "approved" if official else "unverified",
             "starts": starts.isoformat(timespec="minutes"),
             "ends": ends.isoformat(timespec="minutes"),
             "created": now.isoformat(timespec="seconds")}
        with self._lock:
            self.items.append(c)
            self._save()
        return c

    def set_status(self, cid, status):
        if status not in ("approved", "rejected", "unverified"):
            raise ValueError(status)
        with self._lock:
            for c in self.items:
                if c["id"] == cid:
                    c["status"] = status
                    self._save()
                    return c
        return None

    def delete(self, cid):
        with self._lock:
            n = len(self.items)
            self.items = [c for c in self.items if c["id"] != cid]
            self._save()
            return len(self.items) != n

    def active(self, when=None):
        when = when or datetime.now()
        return [c for c in self.items
                if c["status"] != "rejected"
                and _dt(c["starts"]) <= when < _dt(c["ends"])]

    def split(self, when=None):
        """(approved closures that route around, unverified reports that warn)"""
        act = self.active(when)
        return ([c for c in act if c["status"] == "approved"],
                [c for c in act if c["status"] == "unverified"])


def _dt(v):
    if v is None or v == "":
        return None
    return v if isinstance(v, datetime) else datetime.fromisoformat(v)
