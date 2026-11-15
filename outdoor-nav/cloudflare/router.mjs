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
  blockedEdges(closures, origin, virtual) {
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
        const a = u === 'O:start' ? origin : this.data.nodes[u];
        if (pointSegment([c.lat, c.lon], a, this.data.nodes[v]) <= radius) blocked.set(index, c.id);
      }
    }
    return blocked;
  }
  search(targets, blocked, stepFree, virtual) {
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
      const out = node === 'O:start' ? virtual.map((_, i) => count + i) : this.data.out[node] || [];
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
    let links, snapMetres;
    if (startPlace) {
      if (exit !== null && !startPlace.nodes.includes('S:' + exit)) throw new Unreachable('That exit does not belong to this parking structure.');
      links = (exit === null ? startPlace.nodes : ['S:' + exit]).map(n => [n, 0, 0]);
      [lat, lon] = this.data.nodes[startPlace.nodes[0]]; snapMetres = 0;
    } else {
      const [node, d] = this.nearest(lat, lon); snapMetres = d;
      links = [[node, d / 1.35, d]];
    }
    const origin = [lat, lon], virtual = links.map(([n, s, m]) => ['O:start', n, s, m, false, '']);
    const blocked = this.blockedEdges(closures, origin, virtual);
    const found = this.search(targets, blocked, stepFree, virtual);
    if (found.cost === null) {
      const named = [...found.hit].filter(n => n !== 'steps').sort();
      throw new Unreachable(`${b.name}: ${named.length ? 'every way in is closed' : found.hit.has('steps') ? 'stairs on every way in' : 'no path in the map'}`, named);
    }
    let base = null, baseClosures = [];
    if (blocked.size) {
      base = this.search(targets, new Map(), stepFree, virtual);
      if (base.cost !== null) baseClosures = [...new Set(base.edges.filter(i => blocked.has(i)).map(i => blocked.get(i)))].sort();
    }
    const edge = i => i < this.data.edges.length ? this.data.edges[i] : virtual[i - this.data.edges.length];
    const metres = found.edges.reduce((sum, i) => sum + edge(i)[3], 0);
    const path = startPlace ? found.path.slice(1) : found.path;
    if (startPlace) [lat, lon] = this.data.nodes[path[0]];
    const coordinates = path.map(n => n === 'O:start' ? origin : this.data.nodes[n]);
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
