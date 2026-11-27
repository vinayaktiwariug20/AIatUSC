// Feedback: anyone can send it, staff read it, and nothing that identifies the sender is kept.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import {cleanFeedback, FEEDBACK_MAX} from '../cloudflare/feedback.mjs';

const ALL = ['0001_closures.sql', '0002_mobility.sql', '0003_questions.sql', '0004_usage.sql', '0005_parking_status.sql', '0006_staff_keys.sql', '0007_parking_rates.sql', '0008_feedback.sql'];
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
const ADMIN = 'team-admin-token-for-tests';
async function call(env, path, {method = 'GET', body, token} = {}) {
  const headers = {'CF-Connecting-IP': '203.0.113.9'}; if (body) headers['Content-Type'] = 'application/json'; if (token) headers['X-Admin-Token'] = token;
  const r = await worker.fetch(new Request('https://x.test' + path, {method, headers, body: body ? JSON.stringify(body) : undefined}), env);
  return {status: r.status, data: r.status === 204 ? null : await r.json()};
}
const newEnv = (migrations) => ({DB: new D1(migrations), ADMIN_TOKEN: ADMIN});
const ROUTE = {kind: 'route', message: '  That entrance   is closed  ', email: 'someone@example.com',
  route: {mode: 'driving', to: 'jmc', to_name: 'Steven and Kathryn Sample Hall', parking: 'lot2', parking_name: 'Lot 2 (USC Bookstore lot)',
    gate: 'mcclintock', gate_name: 'McClintock Ave. Entrance', minutes: 6.04, from: {lat: 34.033612, lon: -118.281749}, phone: '555', step_free: true}};

test('a "wrong route" note reaches staff with the route attached, the start rounded, and nothing else kept', async () => {
  const env = newEnv();
  assert.equal((await call(env, '/api/feedback', {method: 'POST', body: ROUTE})).status, 201);
  const {status, data} = await call(env, '/api/feedback', {token: ADMIN});
  assert.equal(status, 200);
  const [f] = data.open;
  assert.equal(f.message, 'That entrance is closed');
  assert.deepEqual(f.route.from, [34.034, -118.282]);              // about 100 m, not the exact spot
  assert.equal(f.route.parking, 'lot2'); assert.equal(f.route.minutes, 6); assert.equal(f.route.step_free, true);
  const stored = JSON.stringify(f);
  for (const leaked of ['someone@example.com', '555', '34.033612']) assert.ok(!stored.includes(leaked), leaked);
});

test('only staff can read feedback; a staff key works, not only the team token', async () => {
  const env = newEnv();
  await call(env, '/api/feedback', {method: 'POST', body: {kind: 'general', message: 'My building is missing', trying: 'find Taper Hall'}});
  assert.equal((await call(env, '/api/feedback')).status, 403);
  assert.equal((await call(env, '/api/feedback', {token: 'wrong'})).status, 403);
  const {data: made} = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Transportation dispatch'}, token: ADMIN});
  const {status, data} = await call(env, '/api/feedback', {token: made.key});
  assert.equal(status, 200);
  assert.equal(data.open[0].trying, 'find Taper Hall');
});

test('done moves an item out of the inbox, reopen brings it back', async () => {
  const env = newEnv();
  await call(env, '/api/feedback', {method: 'POST', body: {kind: 'general', message: 'Bigger text please'}});
  const id = (await call(env, '/api/feedback', {token: ADMIN})).data.open[0].id;
  assert.equal((await call(env, `/api/feedback/${id}/done`, {method: 'POST', body: {}})).status, 403);
  assert.equal((await call(env, `/api/feedback/${id}/done`, {method: 'POST', body: {}, token: ADMIN})).status, 200);
  let {data} = await call(env, '/api/feedback', {token: ADMIN});
  assert.equal(data.open.length, 0); assert.equal(data.done.length, 1);
  await call(env, `/api/feedback/${id}/reopen`, {method: 'POST', body: {}, token: ADMIN});
  ({data} = await call(env, '/api/feedback', {token: ADMIN}));
  assert.equal(data.open.length, 1);
  assert.equal((await call(env, '/api/feedback/0123456789abcdef/done', {method: 'POST', body: {}, token: ADMIN})).status, 404);
});

test('empty, too long or unknown feedback is refused', async () => {
  const env = newEnv();
  for (const body of [{kind: 'general', message: '   '}, {kind: 'general', message: 'x'.repeat(FEEDBACK_MAX + 1)}, {kind: 'praise', message: 'hi'},
    {kind: 'general', message: 'ok', trying: 'y'.repeat(201)}])
    assert.equal((await call(env, '/api/feedback', {method: 'POST', body})).status, 400, JSON.stringify(body).slice(0, 40));
  // A route note may be empty (the route itself is the report); ids that aren't ids are dropped.
  assert.deepEqual(cleanFeedback({kind: 'route', route: {mode: 'walking', to: '<script>', parking: 'lot2'}}).item, {kind: 'route', route: {mode: 'walking', parking: 'lot2'}});
});

test('a shared limit keeps anyone from filling the inbox', async () => {
  const env = newEnv();
  for (let i = 0; i < 20; i++) assert.equal((await call(env, '/api/feedback', {method: 'POST', body: {kind: 'general', message: 'note ' + i}})).status, 201);
  assert.equal((await call(env, '/api/feedback', {method: 'POST', body: {kind: 'general', message: 'one more'}})).status, 429);
});

test('before the migration runs, feedback says so instead of failing silently', async () => {
  const env = newEnv(ALL.slice(0, 7));
  const r = await call(env, '/api/feedback', {method: 'POST', body: {kind: 'general', message: 'hello'}});
  assert.equal(r.status, 503); assert.match(r.data.error, /migration 0008/);
});
