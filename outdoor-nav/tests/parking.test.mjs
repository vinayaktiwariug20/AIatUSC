// Parking structure status from the Staff screen: weekly "no daily (Text2Park)
// parking" windows and live Open / Filling / Full updates.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import {WalkRouter} from '../cloudflare/router.mjs';
import {parseTime, campusISO, gateStatus} from '../cloudflare/api.mjs';
import {drivingRoute, readRules} from '../cloudflare/mobility.mjs';

const ALL = ['0001_closures.sql', '0002_mobility.sql', '0003_questions.sql', '0004_usage.sql', '0005_parking_status.sql'];
class D1 {
  constructor(migrations = ALL) {
    this.db = new DatabaseSync(':memory:');
    for (const m of migrations) this.db.exec(readFileSync(new URL('../migrations/' + m, import.meta.url), 'utf8'));
  }
  prepare(sql) {
    let params = []; const self = this;
    return {bind(...v) { params = v; return this; },
      async first(col) { const row = self.db.prepare(sql).get(...params); return row ? (col ? row[col] : row) : null; },
      async run() { return self.db.prepare(sql).run(...params); }};
  }
}
const json = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const context = {router: new WalkRouter(json('cloudflare/graph.json')), gateData: json('data/gates.json'), mobilityData: json('data/mobility.json'),
  footballData: json('data/football.json'), survey: json('data/surveyed.json'), time: {parseTime, campusISO, gateStatus}};
const pause = () => new Promise(r => setTimeout(r, 3));
async function call(env, path, {method = 'GET', body, token = 'staff'} = {}) {
  const headers = {'X-Admin-Token': token}; if (body) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request('https://x.test' + path, {method, headers, body: body ? JSON.stringify(body) : undefined}), env);
  return {status: r.status, data: await r.json()};
}
const post = (env, body, token) => call(env, '/api/mobility/rules', {method: 'POST', body: {kind: 'parking', ...body}, token});
const structure = async (env, at, id, permit) => (await call(env, '/api/mobility?at=' + at + (permit ? '&permit=' + permit : ''))).data.parking.find(p => p.id === id);
// This week's staff text: Downey takes no Text2Park Mon-Thu 6 am-4 pm.
const TEXT2PARK = {parking: 'downey', applies: 'daily', status: 'closed', days: ['Mon', 'Tue', 'Wed', 'Thu'], from: '06:00', to: '16:00',
  starts: '2026-11-16T00:00', ends: '2026-11-23T00:00', note: 'Text2Park closed this week'};

test('a weekly "no Text2Park" window stops daily parkers only, on those days and hours', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  assert.equal((await post(env, TEXT2PARK)).status, 201);
  const tue = await structure(env, '2026-11-17T10:00', 'downey');
  assert.equal(tue.eligible, false);
  assert.match(tue.reason, /^No daily \(Text2Park\) parking until 4 pm: Text2Park closed this week\.$/);
  assert.equal(tue.space.status, 'closed');
  assert.equal((await structure(env, '2026-11-17T16:30', 'downey')).eligible, true);         // after 4 pm
  assert.equal((await structure(env, '2026-11-20T10:00', 'downey')).eligible, true);         // Friday
  assert.equal((await structure(env, '2026-11-24T10:00', 'downey')).eligible, true);         // next week: expired
  assert.equal((await structure(env, '2026-11-17T10:00', 'downey', 'downey')).eligible, true);   // a Downey permit holder
  assert.equal((await structure(env, '2026-11-17T10:00', 'mccarthy')).eligible, true);       // other structures untouched
});

test('live updates: the newest wins, a count shows, and "everyone" includes permit holders', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'}, live = {parking: 'mccarthy', applies: 'everyone', starts: '2026-11-17T08:00', ends: '2026-11-17T20:00'};
  await post(env, {...live, status: 'filling', spaces: 80}); await pause();
  let m = await structure(env, '2026-11-17T12:00', 'mccarthy');
  assert.equal(m.eligible, true); assert.equal(m.occupancy, 'filling'); assert.equal(m.space.spaces, 80);
  await post(env, {...live, status: 'full'}); await pause();
  m = await structure(env, '2026-11-17T12:00', 'mccarthy', 'mccarthy');
  assert.equal(m.eligible, false); assert.match(m.reason, /^Full \(staff update/);
  await post(env, {...live, status: 'open', spaces: 120});
  m = await structure(env, '2026-11-17T12:00', 'mccarthy');
  assert.equal(m.eligible, true); assert.equal(m.occupancy, 'open'); assert.equal(m.space.spaces, 120);
});

test('a weekly closure still holds when a newer live update says "open"', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  await post(env, TEXT2PARK); await pause();
  await post(env, {parking: 'downey', applies: 'everyone', status: 'open', spaces: 300, starts: '2026-11-17T08:00', ends: '2026-11-17T20:00'});
  assert.equal((await structure(env, '2026-11-17T10:00', 'downey')).eligible, false);
});

test('an update older than two hours is marked as possibly out of date', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'}, now = Date.now();
  await post(env, {parking: 'mccarthy', applies: 'everyone', status: 'filling', starts: campusISO(now - 3600000).slice(0, 16), ends: campusISO(now + 5 * 3600000).slice(0, 16)});
  assert.equal((await structure(env, campusISO(now + 60000).slice(0, 16), 'mccarthy')).space.stale, false);
  assert.equal((await structure(env, campusISO(now + 3 * 3600000).slice(0, 16), 'mccarthy')).space.stale, true);
});

test('Auto driving skips a full structure and picks another', async () => {
  const db = new D1(), env = {DB: db, ORS_API_KEY: 'k', ADMIN_TOKEN: 'staff'}, when = parseTime('2026-11-17T12:00:00');
  const fetcher = async (url, options) => {
    const c = JSON.parse(options.body).coordinates;
    return new Response(JSON.stringify({type: 'FeatureCollection', features: [{type: 'Feature', geometry: {type: 'LineString', coordinates: c},
      properties: {summary: {duration: 240, distance: 1200}, segments: [{steps: []}]}}]}), {status: 200});
  };
  const body = {mode: 'driving', from: {lat: 34.027, lon: -118.2871694}, to: 'Doheny', parking: 'auto'};
  const first = await drivingRoute(context, body, when, await readRules(db, when, when + 6 * 3600000), [], env, fetcher);
  assert.equal(first.ok, true);
  const picked = first.summary.parking.id;
  await post(env, {parking: picked, applies: 'everyone', status: 'full', starts: '2026-11-17T08:00', ends: '2026-11-17T20:00'});
  const second = await drivingRoute(context, body, when, await readRules(db, when, when + 6 * 3600000), [], env, fetcher);
  assert.equal(second.ok, true); assert.notEqual(second.summary.parking.id, picked);
});

test('staff only; bad input is refused; Lift removes it', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  assert.equal((await post(env, TEXT2PARK, 'wrong')).status, 403);
  assert.equal((await post(env, {...TEXT2PARK, parking: 'nowhere'})).status, 400);
  assert.equal((await post(env, {...TEXT2PARK, status: 'busy'})).status, 400);
  assert.equal((await post(env, {...TEXT2PARK, applies: 'cars'})).status, 400);
  assert.equal((await post(env, {...TEXT2PARK, from: '16:00', to: '06:00'})).status, 400);
  assert.equal((await post(env, {...TEXT2PARK, days: []})).status, 400);
  assert.equal((await post(env, {...TEXT2PARK, spaces: -3})).status, 400);
  const saved = (await post(env, TEXT2PARK)).data;
  const listed = (await call(env, '/api/mobility/rules?at=2026-11-17T10:00')).data;
  assert.ok(listed.some(r => r.id === saved.id && r.kind === 'parking'));
  assert.equal((await call(env, '/api/mobility/rules/' + saved.id, {method: 'DELETE'})).status, 200);
  assert.equal((await structure(env, '2026-11-17T10:00', 'downey')).eligible, true);
});

test('before migration 0005: routes and the map work; saving says what is missing', async () => {
  const env = {DB: new D1(ALL.slice(0, 4)), ADMIN_TOKEN: 'staff'};
  assert.equal((await structure(env, '2026-11-17T10:00', 'downey')).eligible, true);
  const r = await post(env, TEXT2PARK);
  assert.equal(r.status, 503); assert.match(r.data.error, /migration 0005/);
  assert.equal((await call(env, '/api/health')).data.parking_status_migration, 'required');
});
