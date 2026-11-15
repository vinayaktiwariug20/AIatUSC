// Indoor viewer: the navigation graph, routing and the packed scene files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {route, describe, snapToGraph, findPlace, placeEnd, buildGraph} from '../outdoor/static/indoor/nav.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'outdoor', 'static', 'indoor');
const B = JSON.parse(readFileSync(join(dir, 'building.json'), 'utf8'));
const NAV = B.nav;
const end = id => placeEnd(B, findPlace(B, id));

test('every edge joins two known nodes and its length matches the geometry', () => {
  for (const e of NAV.edges) {
    const a = NAV.nodes[e.a], b = NAV.nodes[e.b];
    assert.ok(a && b, `${e.a} -> ${e.b}`);
    assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - e.len) < 0.02);
  }
});

test('the graph is one connected piece', () => {
  const adj = buildGraph(NAV), seen = new Set(['ent_front']), todo = ['ent_front'];
  while (todo.length) for (const l of adj.get(todo.pop())) if (!seen.has(l.to)) { seen.add(l.to); todo.push(l.to); }
  assert.equal(seen.size, Object.keys(NAV.nodes).length);
});

test('every place points at a node, and every stair climbs one storey', () => {
  for (const p of B.places) assert.ok(NAV.nodes[p.node], p.id);
  for (const s of NAV.stairs) {
    const a = NAV.nodes[s.nodes[0]], b = NAV.nodes[s.nodes[s.nodes.length - 1]];
    assert.equal(a.y, 0);
    assert.equal(b.y, B.storey_height);
  }
});

test('entrance to the second-floor bridge goes up the middle stair', () => {
  const r = route(NAV, end('entrance'), end('bridge-right'));
  const stairs = r.legs.filter(l => l.kind === 'stairs');
  assert.equal(stairs.length, 1);
  assert.equal(stairs[0].stair, 'the middle stair');
  assert.equal(stairs[0].up, true);
  assert.ok(r.length > 50 && r.length < 90, String(r.length));
});

test('the first-floor middle is blocked: left wing to right wing on floor 1 needs two stairs', () => {
  const r = route(NAV, 'l1_corner', 'r1_corner');
  assert.equal(r.legs.filter(l => l.kind === 'stairs').length, 2);
  assert.ok(r.points.some(p => p.floor === 2));
});

test('a route between two tapped points on one hallway is the straight distance', () => {
  const a = snapToGraph(NAV, {x: -2.0, z: -10, floor: 1}), b = snapToGraph(NAV, {x: -2.6, z: 4, floor: 1});
  assert.ok(a.dist < 0.5 && b.dist < 0.5);
  const r = route(NAV, a, b);
  assert.ok(Math.abs(r.length - 14) < 0.05, String(r.length));
  assert.equal(r.legs.length, 1);
});

test('a tapped point snaps to the right floor', () => {
  const up = snapToGraph(NAV, {x: 30, z: 13.4, floor: 2});
  assert.equal(up.floor, 2);
  assert.equal(up.area, 'the middle hallway');
  const r = route(NAV, end('entrance'), up);
  assert.equal(r.points[r.points.length - 1].floor, 2);
});

test('steps read as start, legs, arrive', () => {
  const r = route(NAV, end('entrance'), end('elevator-2'));
  const steps = describe(r, 'Entrance', 'Elevator, floor 2');
  assert.match(steps[0], /^Start at Entrance/);
  assert.ok(steps.some(s => /middle stair up to floor 2/.test(s)));
  assert.match(steps[steps.length - 1], /^Arrive at Elevator/);
});

test('places are found by id or name; an unmapped room is not', () => {
  assert.equal(findPlace(B, 'ENTRANCE').id, 'entrance');
  assert.equal(findPlace(B, 'Elevator, floor 2').id, 'elevator-2');
  assert.equal(findPlace(B, 'room_205'), null);
});

test('scene files exist and fit the 25 MiB per-file asset limit', () => {
  const S = JSON.parse(readFileSync(join(dir, 'scene', 'scene.json'), 'utf8'));
  let total = 0;
  for (const s of S.scans) {
    const size = statSync(join(dir, 'scene', s.file)).size;
    assert.equal(size, s.bytes, s.file);
    assert.ok(size < 25 * 1024 * 1024, s.file);
    total += size;
  }
  assert.equal(total, S.bytes);
  assert.equal(S.scans.length, 11);
});
