// Gates scheduled closed on foot are a preference, not a wall: the DPS schedule is
// official but not kept strictly. Avoid them for a small detour (a bigger one at
// night), otherwise walk through with a note. Staff closures still block.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); for (const m of ['0001_closures.sql', '0002_mobility.sql']) this.db.exec(readFileSync(new URL('../migrations/' + m, import.meta.url), 'utf8')); }
  prepare(sql) { let params = []; const self = this; return {bind(...v) { params = v; return this; },
    async first(col) { const row = self.db.prepare(sql).get(...params); return row ? (col ? row[col] : row) : null; },
    async run() { return self.db.prepare(sql).run(...params); }}; }
}
// From Vermont Ave, just west of the Downey Way gate, to Doheny: the direct walk goes through the gate.
const WALK = {mode: 'walking', from: {lat: 34.0222, lon: -118.2925}, to: 'Doheny'};
async function walk(at, env = {}) {
  const r = await worker.fetch(new Request('https://x.test/api/outdoor/route', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...WALK, at})}), env);
  return (await r.json()).summary;
}

test('scheduled open: the direct route, no note', async () => {
  const s = await walk('2026-11-17T12:00:00');                 // Tuesday noon
  assert.deepEqual(s.gate_notes, []); assert.ok(s.minutes < 13);
});

test('scheduled closed by day, and the detour is long: walk through, with a neutral note', async () => {
  const s = await walk('2026-11-28T12:00:00');                 // Saturday noon
  assert.ok(s.minutes < 13);
  assert.equal(s.gate_notes.length, 1); assert.equal(s.gate_notes[0].kind, 'through');
  assert.match(s.gate_notes[0].text, /goes through Downey Way Entrance, which is scheduled closed on foot now\. It may be locked; the nearest gate scheduled open is /);
  assert.doesNotMatch(s.gate_notes[0].text, /usually|often/);
});

test('at night a bigger detour is worth it: the route avoids the gate', async () => {
  const s = await walk('2026-11-18T02:00:00');                 // Wednesday 2 am
  assert.equal(s.gate_notes[0].kind, 'avoided');
  assert.match(s.gate_notes[0].text, /^Avoiding Downey Way Entrance: scheduled closed on foot now \(about [\d.]+ extra min\)\.$/);
  assert.ok(s.minutes > 13);
  assert.ok(!s.avoided.some(a => String(a.closure?.id ?? a.closure).startsWith('schedule:')));   // not shown as a "blockage"
});

test('the hour DPS locks up counts as a small-detour preference', async () => {
  const s = await walk('2026-11-17T23:30:00');                 // Tuesday 11:30 pm ("varies")
  assert.equal(s.gate_notes[0].kind, 'through');
});

test('a staff closure on foot still blocks outright, with no schedule note', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  const post = await worker.fetch(new Request('https://x.test/api/mobility/rules', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Admin-Token': 'staff'},
    body: JSON.stringify({kind: 'gate', gate: 'downey-way', modes: ['walking'], starts: '2026-11-28T10:00', ends: '2026-11-28T14:00', note: 'Event setup'})}), env);
  assert.equal(post.status, 201);
  const s = await walk('2026-11-28T12:00:00', env);
  assert.ok(s.minutes > 13); assert.deepEqual(s.gate_notes, []);
});
