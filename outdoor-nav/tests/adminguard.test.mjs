// Guessing the admin token: many different wrong tokens lock staff actions for a
// while, but a repeated typo, other connections and ordinary use are unaffected.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import {adminGuard, ADMIN_GUARD} from '../cloudflare/adminguard.mjs';

const ALL = ['0001_closures.sql', '0002_mobility.sql', '0003_questions.sql', '0004_usage.sql'];
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
async function call(env, path, {method = 'GET', body, token, ip = '203.0.113.5'} = {}) {
  const headers = {'CF-Connecting-IP': ip}; if (body) headers['Content-Type'] = 'application/json'; if (token !== undefined) headers['X-Admin-Token'] = token;
  const r = await worker.fetch(new Request('https://x.test' + path, {method, headers, body: body ? JSON.stringify(body) : undefined}), env);
  return r.status;
}
const TOKEN = 'the-real-admin-token';

test('ten different wrong tokens lock staff actions from that connection only', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: TOKEN};
  for (let i = 0; i < ADMIN_GUARD.max_wrong; i++) assert.equal(await call(env, '/api/stats', {token: 'guess-' + i}), 403);
  assert.equal(await call(env, '/api/stats', {token: TOKEN}), 429);                      // even the right token, for now
  assert.equal(await call(env, '/api/stats', {token: TOKEN, ip: '198.51.100.7'}), 200);  // another connection is fine
  assert.equal(await call(env, '/api/stats', {method: 'POST', body: {kind: 'visit'}, token: 'guess-0'}), 204);  // ordinary use still works
  assert.equal(await call(env, '/api/health', {token: TOKEN}), 200);
});

test('the page resending the same typo never locks anyone out', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: TOKEN};
  for (let i = 0; i < 40; i++) await call(env, '/api/stats', {token: 'the-real-admin-tokn'});
  assert.equal(await call(env, '/api/stats', {token: TOKEN}), 200);
});

test('the lock ends when the window does, and nothing readable about the connection is stored', async () => {
  const db = new D1(), env = {ADMIN_TOKEN: TOKEN}, now = Date.UTC(2026, 10, 21, 18, 0, 0);
  const req = token => new Request('https://x.test/api/stats', {headers: {'X-Admin-Token': token, 'CF-Connecting-IP': '203.0.113.5'}});
  for (let i = 0; i < ADMIN_GUARD.max_wrong; i++) assert.equal(await adminGuard(req('g' + i), env, db, now), null);
  assert.match(await adminGuard(req(TOKEN), env, db, now), /Too many wrong admin tokens/);
  assert.equal(await adminGuard(req(TOKEN), env, db, now + ADMIN_GUARD.window_ms), null);
  const slots = db.db.prepare('SELECT slot FROM routing_usage').all().map(r => r.slot).join(' ');
  assert.ok(!slots.includes('203.0.113.5') && !slots.includes('g1'));
});

test('without the usage table, or without a token header, the guard stays out of the way', async () => {
  const env = {DB: new D1(ALL.slice(0, 1)), ADMIN_TOKEN: TOKEN};
  for (let i = 0; i < 15; i++) await adminGuard(new Request('https://x.test/', {headers: {'X-Admin-Token': 'g' + i}}), env, env.DB);
  assert.equal(await adminGuard(new Request('https://x.test/', {headers: {'X-Admin-Token': TOKEN}}), env, env.DB), null);
  assert.equal(await adminGuard(new Request('https://x.test/'), {DB: new D1(), ADMIN_TOKEN: TOKEN}, new D1()), null);
});
