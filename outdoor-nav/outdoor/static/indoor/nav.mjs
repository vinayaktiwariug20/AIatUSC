// Indoor routing for Doorstep. Pure functions over the graph in building.json, shared by the viewer and the tests.
// Frame: x left wing -> right wing, y up, z courtyard -> front. Metres.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Seconds to walk an edge. Stairs are slower than hallways. */
export function edgeSeconds(nav, e) {
  return e.len / (e.kind === 'stairs' ? nav.stair_speed : nav.walk_speed);
}

export function buildGraph(nav) {
  const adj = new Map();
  for (const id of Object.keys(nav.nodes)) adj.set(id, []);
  nav.edges.forEach((e, i) => {
    const w = edgeSeconds(nav, e);
    adj.get(e.a).push({to: e.b, edge: i, w});
    adj.get(e.b).push({to: e.a, edge: i, w});
  });
  return adj;
}

/** Nearest point on the walkable graph to a point on one floor. Stair edges are skipped. */
export function snapToGraph(nav, p) {
  let best = null;
  nav.edges.forEach((e, i) => {
    if (e.kind === 'stairs') return;
    const a = nav.nodes[e.a], b = nav.nodes[e.b];
    if (a.floor !== p.floor || b.floor !== p.floor) return;
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    const x = a.x + dx * t, z = a.z + dz * t, d = Math.hypot(p.x - x, p.z - z);
    if (!best || d < best.dist) best = {edge: i, t, x, y: a.y + (b.y - a.y) * t, z, floor: p.floor, dist: d, area: (t < 0.5 ? a : b).area};
  });
  return best;
}

// An end of a route is either a node id or a snapped point from snapToGraph.
function attach(nav, adj, nodes, end, tag) {
  if (typeof end === 'string') {
    if (!nav.nodes[end]) throw new Error('unknown node ' + end);
    return end;
  }
  const e = nav.edges[end.edge], id = '#' + tag;
  nodes[id] = {x: end.x, y: end.y, z: end.z, floor: end.floor, area: end.area};
  const per = edgeSeconds(nav, e) / (e.len || 1);
  const links = [[e.a, dist(nodes[id], nav.nodes[e.a])], [e.b, dist(nodes[id], nav.nodes[e.b])]];
  adj.set(id, links.map(([to, len]) => ({to, edge: end.edge, w: len * per, len})));
  for (const [to, len] of links) adj.get(to).push({to: id, edge: end.edge, w: len * per, len});
  return id;
}

/**
 * Fastest route between two ends (node ids or snapped points).
 * Returns null when there is no way through, else {points, length, seconds, legs}.
 */
export function route(nav, from, to) {
  const base = buildGraph(nav), adj = new Map([...base].map(([k, v]) => [k, v.slice()]));
  const nodes = {...nav.nodes};
  const s = attach(nav, adj, nodes, from, 'from'), t = attach(nav, adj, nodes, to, 'to');
  // both ends on the same edge: let them see each other directly
  if (typeof from !== 'string' && typeof to !== 'string' && from.edge === to.edge) {
    const len = dist(nodes[s], nodes[t]), e = nav.edges[from.edge], w = len * edgeSeconds(nav, e) / (e.len || 1);
    adj.get(s).push({to: t, edge: from.edge, w, len});
    adj.get(t).push({to: s, edge: from.edge, w, len});
  }
  const best = new Map([[s, 0]]), prev = new Map(), done = new Set();
  for (;;) {
    let u = null, bu = Infinity;
    for (const [k, v] of best) if (!done.has(k) && v < bu) { u = k; bu = v; }
    if (u === null) return null;
    if (u === t) break;
    done.add(u);
    for (const l of adj.get(u)) {
      const v = bu + l.w;
      if (v < (best.get(l.to) ?? Infinity)) { best.set(l.to, v); prev.set(l.to, {from: u, link: l}); }
    }
  }
  const ids = [t], links = [];
  while (ids[0] !== s) { const p = prev.get(ids[0]); links.unshift(p.link); ids.unshift(p.from); }
  const points = ids.map(id => ({id, ...nodes[id]}));
  let length = 0;
  const legs = [];
  const onStair = p => nav.stairs.some(st => st.nodes.includes(p.id));
  links.forEach((l, i) => {
    const a = points[i], b = points[i + 1], e = nav.edges[l.edge], len = l.len ?? e.len;
    length += len;
    const kind = e.kind === 'stairs' ? 'stairs' : 'walk', last = legs[legs.length - 1];
    // a walking leg is described by the places it passes; the foot or head of a stair is not one of them
    const named = kind === 'walk' ? [a, b].filter(p => !onStair(p)).map(p => p.area) : [a.area];
    if (last && last.kind === kind) {
      last.length += len; last.seconds += l.w; last.to = b;
      for (const area of named) if (last.areas[last.areas.length - 1] !== area) last.areas.push(area);
    } else {
      legs.push({kind, length: len, seconds: l.w, from: a, to: b, areas: named.filter((x, k) => k === 0 || x !== named[k - 1])});
    }
  });
  for (const leg of legs) {
    if (leg.kind !== 'stairs') continue;
    leg.up = leg.to.y > leg.from.y;
    leg.stair = (nav.stairs.find(st => st.nodes.includes(leg.from.id) || st.nodes.includes(leg.to.id)) || {}).name || 'the stairs';
    leg.toFloor = leg.to.floor;
  }
  return {points, length, seconds: best.get(t), legs};
}

/** Plain-language steps for a route. */
export function describe(r, startName, endName) {
  if (!r) return [];
  const steps = [`Start at ${startName}.`];
  r.legs.forEach((leg, i) => {
    if (leg.kind === 'stairs') {
      steps.push(`Take ${leg.stair} ${leg.up ? 'up' : 'down'} to floor ${leg.toFloor}.`);
    } else {
      const m = Math.max(1, Math.round(leg.length));
      const through = leg.areas.filter((a, k) => k === 0 || a !== leg.areas[k - 1]);
      if (!through.length) { steps.push(`Walk ${m} m.`); return; }
      const where = through.length > 1 ? `from ${through[0]} to ${through[through.length - 1]}` : `along ${through[0]}`;
      const via = through.length > 2 ? `, through ${through.slice(1, -1).join(', then ')}` : '';
      steps.push(`Walk ${m} m ${where}${via}.`);
    }
  });
  steps.push(`Arrive at ${endName}.`);
  return steps;
}

/** Find a place or a room by id or by name (case and punctuation ignored). */
export function findPlace(building, key) {
  if (!key) return null;
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const k = norm(key);
  const all = [...building.places.map(p => ({...p, type: 'place'})), ...(building.rooms || []).map(r => ({...r, type: 'room'}))];
  return all.find(p => norm(p.id) === k) || all.find(p => norm(p.name || '') === k) ||
    (building.nav.nodes[key] ? {id: key, node: key, name: building.nav.nodes[key].area, type: 'node'} : null);
}

/** Where a place sits on the graph: a node id, or a snapped point for rooms given as coordinates. */
export function placeEnd(building, place) {
  if (place.node) return place.node;
  return snapToGraph(building.nav, {x: place.x, z: place.z, floor: place.floor});
}

export function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  return m < 1 ? 'under 1 min' : `${m} min`;
}
