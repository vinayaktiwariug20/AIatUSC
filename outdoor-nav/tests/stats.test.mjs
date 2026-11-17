// Site-wide counts for the team: anonymous, per day, admin-only to read.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

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
async function call(env, path, method = 'GET', body, token) {
  const headers = {}; if (body) headers['Content-Type'] = 'application/json'; if (token) headers['X-Admin-Token'] = token;
  const r = await worker.fetch(new Request('https://x.test' + path, {method, headers, body: body ? JSON.stringify(body) : undefined}), env);
  return {status: r.status, data: r.status === 204 ? null : await r.json()};
}

test('site counts add up per kind; reading them needs the admin token', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'secret-token'};
  for (const kind of ['visit', 'visit', 'visit', 'route_walk', 'start_address', 'drive_handoff'])
    assert.equal((await call(env, '/api/stats', 'POST', {kind})).status, 204);
  assert.equal((await call(env, '/api/stats')).status, 403);
  assert.equal((await call(env, '/api/stats', 'GET', null, 'wrong')).status, 403);
  const {data} = await call(env, '/api/stats?days=7', 'GET', null, 'secret-token');
  assert.equal(data.stats.totals.visit, 3);
  assert.equal(data.stats.totals.route_walk, 1);
  assert.equal(data.stats.totals.start_address, 1);
  assert.equal(data.stats.totals.route_drive, 0);
  assert.equal(data.stats.days.length, 1);
});

test('unknown kinds are refused; site counts never mix with event-link counts', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 't'};
  assert.equal((await call(env, '/api/stats', 'POST', {kind: 'location'})).status, 400);
  await call(env, '/api/stats', 'POST', {kind: 'arrive'});
  const links = env.DB.db.prepare("SELECT DISTINCT link FROM usage_counts").all().map(r => r.link);
  assert.deepEqual(links, ['_site']);
  const cols = env.DB.db.prepare("SELECT name FROM pragma_table_info('usage_counts')").all().map(r => r.name).sort();
  assert.deepEqual(cols, ['count', 'day', 'kind', 'link']);             // nothing personal
});

test('before migration 0004, counting is a silent no-op and reading says so', async () => {
  const env = {DB: new D1(ALL.slice(0, 3)), ADMIN_TOKEN: 't'};
  assert.equal((await call(env, '/api/stats', 'POST', {kind: 'visit'})).status, 204);
  assert.equal((await call(env, '/api/stats', 'GET', null, 't')).data.stats, null);
});
