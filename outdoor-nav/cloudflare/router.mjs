// Cloudflare adapter of outdoor/router.py. The original Python engine remains.
// The compiled graph is immutable during requests; origins are virtual links.
const CELL = 0.001;
const R = 6371000;
const RAD = Math.PI / 180;
const round1 = x => Math.round(x * 10) / 10;
export function haversine(a, b) {
  const x = a[0] * RAD, y = b[0] * RAD;
  const h = Math.sin((y - x) / 2) ** 2 + Math.cos(x) * Math.cos(y) * Math.sin((b[1] - a[1]) * RAD / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function pointSegment(p, a, b) {
  const k = Math.cos(p[0] * RAD);
  const ax = (a[1] - p[1]) * k * 111320, ay = (a[0] - p[0]) * 110540;
  const dx = (b[1] - a[1]) * k * 111320, dy = (b[0] - a[0]) * 110540;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
// Foot of the perpendicular from p onto segment a-b: [metres, t along a->b, [lat, lon]].
// Same arithmetic as outdoor/geo.py project().
export function project(p, a, b) {
  const k = Math.cos(p[0] * RAD);
  const ax = (a[1] - p[1]) * k * 111320, ay = (a[0] - p[0]) * 110540;
  const bx = (b[1] - p[1]) * k * 111320, by = (b[0] - p[0]) * 110540;
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
  return [Math.hypot(ax + t * dx, ay + t * dy), t, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]];
}
// Python's float `//` (CPython float_floor_div). Math.floor(a / b) can land in
// the neighbouring cell at a boundary, and the segment grid is keyed by Python.
export function floorDiv(vx, wx) {
  let mod = vx % wx, div = (vx - mod) / wx;
  if (mod && ((wx < 0) !== (mod < 0))) { mod += wx; div -= 1; }
  if (!div) return 0;
  let fd = Math.floor(div);
  if (div - fd > 0.5) fd += 1;
  return fd;
}
export class Unreachable extends Error {
  constructor(reason, blockedBy = [], choices = []) {
    super(reason); this.blockedBy = blockedBy; this.choices = choices;
  }
}
class Heap {
  data = [];
  less(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }
  push(value) {
    const a = this.data; a.push(value); let i = a.length - 1;
    while (i) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.data, value = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      while (true) {
        let next = i, left = i * 2 + 1, right = left + 1;
        if (left < a.length && this.less(a[left], a[next])) next = left;
        if (right < a.length && this.less(a[right], a[next])) next = right;
        if (next === i) break;
        [a[i], a[next]] = [a[next], a[i]]; i = next;
      }
    }
    return value;
  }
}

export class WalkRouter {
  constructor(data) { this.data = data; }
  containsStart(lat, lon) {
    const [s, w, n, e] = this.data.bounds;
    return lat >= s - .01 && lat <= n + .01 && lon >= w - .01 && lon <= e + .01;
  }
  candidates(text) {
    const t = String(text ?? '').trim().toLowerCase(), all = Object.values(this.data.buildings);
    if (!t) return [];
    if (Object.hasOwn(this.data.buildings, t)) return [this.data.buildings[t]];
    const exact = all.filter(b => b.name.toLowerCase() === t || (b.aliases || []).some(a => a.toLowerCase() === t));
    return exact.length ? exact : all.filter(b => b.name.toLowerCase().includes(t) || (b.aliases || []).some(a => a.toLowerCase().includes(t)));
  }
  findBuilding(text) {
    const choices = this.candidates(text);
    if (choices.length === 1) return choices[0];
    const surveyed = choices.filter(b => b.surveyed);
    if (surveyed.length === 1 && choices.every(b => haversine([surveyed[0].lat, surveyed[0].lon], [b.lat, b.lon]) <= 60)) return surveyed[0];
    return null;
  }
  findPlace(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (Object.hasOwn(this.data.places, t)) return this.data.places[t];
    const choices = Object.values(this.data.places).filter(p => t && p.name.toLowerCase().includes(t));
    return choices.length === 1 ? choices[0] : null;
  }
  nearest(lat, lon) {
    const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
    let best = null, distance = Infinity;
    for (let r = 0; r < 400; r++) {
      if (best !== null && (r - 1) * CELL * 92000 > distance) break;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const node of this.data.cells[`${i},${j}`] || []) {
          const d = haversine([lat, lon], this.data.nodes[node]);
          if (d < distance) { best = node; distance = d; }
        }
      }
    }
    return [best, distance];
  }
  // Nearest point on a real path SEGMENT (not node). Mirrors router.py _snap_edge.
  snapEdge(lat, lon, radius = 150) {
    const ci = floorDiv(lat, CELL), cj = floorDiv(lon, CELL), segs = this.data.segCells;
    let r = Math.max(1, Math.trunc(radius / (CELL * 92000)) + 1), best = null;
    for (let grow = 0; grow < 6; grow++) {
      best = null; const seen = new Set();
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        for (const ei of segs[`${i},${j}`] || []) {
          if (seen.has(ei)) continue;
          seen.add(ei);
          const [u, v] = this.data.edges[ei];
          const [d, t, foot] = project([lat, lon], this.data.nodes[u], this.data.nodes[v]);
          if (best === null || d < best[1]) best = [ei, d, t, foot];
        }
      }
      if (best !== null && best[1] <= r * CELL * 92000) return best;
      r *= 2;
    }
    return best;
  }
  blockedEdges(closures, coord, virtual) {
    const blocked = new Map(), count = this.data.edges.length;
    for (const c of closures) {
      const radius = c.radius_m ?? 15, dy = radius / 110540, dx = radius / (111320 * Math.cos(c.lat * RAD));
      const candidates = new Set(virtual.map((_, i) => count + i));
      for (let i = Math.floor((c.lat - dy) / CELL); i <= Math.floor((c.lat + dy) / CELL); i++) {
        for (let j = Math.floor((c.lon - dx) / CELL); j <= Math.floor((c.lon + dx) / CELL); j++) {
          for (const index of this.data.edgeCells[`${i},${j}`] || []) candidates.add(index);
        }
      }
      for (const index of candidates) {
        if (blocked.has(index)) continue;
        const [u, v] = index < count ? this.data.edges[index] : virtual[index - count];
        if (pointSegment([c.lat, c.lon], coord(u), coord(v)) <= radius) blocked.set(index, c.id);
      }
    }
    return blocked;
  }
  search(targets, blocked, stepFree, virtual, vout) {
    const wanted = new Set(targets), best = new Map([['O:start', 0]]), prev = new Map(), heap = new Heap(), hit = new Set();
    const count = this.data.edges.length; heap.push([0, 'O:start']);
    while (heap.data.length) {
      const [cost, node] = heap.pop();
      if (cost > (best.get(node) ?? Infinity)) continue;
      if (wanted.has(node)) {
        const path = [node], edges = []; let cur = node;
        while (cur !== 'O:start') { const [parent, index] = prev.get(cur); edges.push(index); path.push(parent); cur = parent; }
        return {cost, path: path.reverse(), edges: edges.reverse(), hit};
      }
      const real = this.data.out[node] || [], extra = vout.get(node);
      const out = extra ? real.concat(extra) : real;
      for (const index of out) {
        const [, v, seconds, , steps] = index < count ? this.data.edges[index] : virtual[index - count];
        if (blocked.has(index)) { hit.add(blocked.get(index)); continue; }
        if (steps && stepFree) { hit.add('steps'); continue; }
        const next = cost + seconds;
        if (next < (best.get(v) ?? Infinity)) { best.set(v, next); prev.set(v, [node, index]); heap.push([next, v]); }
      }
    }
    return {cost: null, path: null, edges: null, hit};
  }
  route({lat, lon, building, closures = [], reports = [], stepFree = false, place = null, exit = null}) {
    let startPlace = null;
    if (place !== null) { startPlace = this.findPlace(place); if (!startPlace) throw new Unreachable(`unknown place: '${place}'`); }
    const b = this.findBuilding(building);
    if (!b) {
      const choices = this.candidates(building);
      if (choices.length > 1) throw new Unreachable(`'${building}' could mean ${choices.length} places -- which one?`, [], choices.map(b => ({id: b.id, name: b.name})));
      throw new Unreachable(`unknown building: '${building}'`);
    }
    const targets = this.data.targets[b.id] || [];
    if (!targets.length) throw new Unreachable(`${b.name} has no entrance within 60m of a mapped path`);
    // Virtual nodes and edges for this request only (the compiled graph is
    // shared and immutable). Same order as router.py's _link(..., live=True).
    const vnodes = new Map(), virtual = [], vout = new Map(), count = this.data.edges.length;
    const link = (u, v, s, m, steps = false, name = '') => {
      for (const [a, b] of [[u, v], [v, u]]) {
        virtual.push([a, b, s, m, steps, name]);
        if (!vout.has(a)) vout.set(a, []);
        vout.get(a).push(count + virtual.length - 1);
      }
    };
    let snapMetres;
    if (startPlace) {
      if (exit !== null && !startPlace.nodes.includes('S:' + exit)) throw new Unreachable('That exit does not belong to this parking structure.');
      [lat, lon] = this.data.nodes[startPlace.nodes[0]];
      vnodes.set('O:start', [lat, lon]);
      for (const n of (exit === null ? startPlace.nodes : ['S:' + exit])) link('O:start', n, 0, 0);
      snapMetres = 0;
    } else {
      const snap = this.snapEdge(lat, lon, 150);
      if (!snap) throw new Unreachable('no mapped path anywhere near the start point');
      const [ei, d, t, foot] = snap, [u, v, sec, m, steps, name] = this.data.edges[ei], P = 'P:O:start';
      vnodes.set('O:start', [lat, lon]); vnodes.set(P, foot);
      link('O:start', P, d / 1.35, d);
      link(P, u, sec * t, m * t, steps, name);
      link(P, v, sec * (1 - t), m * (1 - t), steps, name);
      snapMetres = d;
    }
    const coord = n => vnodes.get(n) ?? this.data.nodes[n];
    const blocked = this.blockedEdges(closures, coord, virtual);
    const found = this.search(targets, blocked, stepFree, virtual, vout);
    if (found.cost === null) {
      const named = [...found.hit].filter(n => n !== 'steps').sort();
      throw new Unreachable(`${b.name}: ${named.length ? 'every way in is closed' : found.hit.has('steps') ? 'stairs on every way in' : 'no path in the map'}`, named);
    }
    let base = null, baseClosures = [];
    if (blocked.size) {
      base = this.search(targets, new Map(), stepFree, virtual, vout);
      if (base.cost !== null) baseClosures = [...new Set(base.edges.filter(i => blocked.has(i)).map(i => blocked.get(i)))].sort();
    }
    const edge = i => i < this.data.edges.length ? this.data.edges[i] : virtual[i - this.data.edges.length];
    const metres = found.edges.reduce((sum, i) => sum + edge(i)[3], 0);
    const path = startPlace ? found.path.slice(1) : found.path;
    if (startPlace) [lat, lon] = this.data.nodes[path[0]];
    const coordinates = path.map(coord);
    const entranceId = path.at(-1).slice(2), entrance = (b.entrances || []).find(e => e.id === entranceId);
    const entranceLL = this.data.nodes[path.at(-1)], toDoor = haversine([lat, lon], entranceLL);
    const warnings = reports.filter(r => coordinates.slice(1).some((q, i) => pointSegment([r.lat, r.lon], coordinates[i], q) <= 30 + (r.radius_m || 0)));
    const point = (ll, properties) => ({type: 'Feature', properties, geometry: {type: 'Point', coordinates: [ll[1], ll[0]]}});
    return {
      type: 'FeatureCollection',
      summary: {
        building: b.id, building_name: b.name, minutes: round1(found.cost / 60), metres: Math.round(metres),
        near_venue: toDoor <= 75, distance_to_entrance_m: Math.round(toDoor), off_network: snapMetres > 150,
        snap_m: Math.round(snapMetres), entrance_source: entrance ? (b.entrance_source || 'osm') : 'outline',
        step_free: stepFree, start_place: startPlace ? {id: startPlace.id, name: startPlace.name, exit: path[0].slice(2)} : null,
        avoided: baseClosures.map(closure => ({closure, extra_min: round1(Math.max(0, found.cost - base.cost) / 60)})),
        warnings: warnings.map(r => ({id: r.id, note: r.note || '', status: r.status})),
      },
      handoff: {building: b.id, entrance_id: entrance?.id ?? null, entrance_name: entrance?.name ?? null,
        indoor_node: entrance?.indoor_node ?? null, lat: entranceLL[0], lon: entranceLL[1]},
      features: [
        {type: 'Feature', properties: {kind: 'route', minutes: round1(found.cost / 60), metres: Math.round(metres)},
          geometry: {type: 'LineString', coordinates: coordinates.map(([a, b]) => [b, a])}},
        point([lat, lon], {kind: 'start'}),
        point(entranceLL, {kind: 'entrance', name: entrance?.name || b.name, guess: !entrance}),
      ],
      attribution: this.data.attribution,
    };
  }
}
