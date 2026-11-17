// Anonymous usage counts: daily totals per event link, nothing personal.
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
async function call(env, path, method = 'GET', body) {
  const r = await worker.fetch(new Request('https://x.test' + path, {method,
    headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined}), env);
  return {status: r.status, data: r.status === 204 ? null : await r.json()};
}
const DMC_ID = 'dr-joseph-medicine-crow-center-for-international-and-public-affairs';
const link = {to: DMC_ID, room: '258', event: 'AI@USC Showcase'};

test('counts accumulate per event link and kind', async () => {
  const env = {DB: new D1()};
  for (const kind of ['open', 'open', 'route', 'arrive', 'inside'])
    assert.equal((await call(env, '/api/usage', 'POST', {...link, kind})).status, 204);
  const q = new URLSearchParams(link).toString();
  const t = (await call(env, '/api/usage?' + q)).data.totals;
  assert.deepEqual(t, {open: 2, route: 1, arrive: 1, inside: 1, ask: 0});
  // a different event in the same room is a different link
  const other = (await call(env, '/api/usage?' + new URLSearchParams({...link, event: 'Other night'}))).data.totals;
  assert.equal(other.open, 0);
});

test('the same link counts together whether it says DMC or the full building id', async () => {
  const env = {DB: new D1()};
  await call(env, '/api/usage', 'POST', {...link, to: 'DMC', kind: 'open'});
  await call(env, '/api/usage', 'POST', {...link, kind: 'open'});
  assert.equal((await call(env, '/api/usage?' + new URLSearchParams(link))).data.totals.open, 2);
});

test('only known kinds and buildings; nothing personal is stored', async () => {
  const env = {DB: new D1()};
  assert.equal((await call(env, '/api/usage', 'POST', {...link, kind: 'gps'})).status, 400);
  assert.equal((await call(env, '/api/usage', 'POST', {...link, to: 'nowhere', kind: 'open'})).status, 400);
  const cols = env.DB.db.prepare("SELECT name FROM pragma_table_info('usage_counts')").all().map(r => r.name).sort();
  assert.deepEqual(cols, ['count', 'day', 'kind', 'link']);           // no ip, user, device or location column
});

test('before the migration, counting is a silent no-op, not an error', async () => {
  const env = {DB: new D1(ALL.slice(0, 3))};
  assert.equal((await call(env, '/api/usage', 'POST', {...link, kind: 'open'})).status, 204);
  assert.equal((await call(env, '/api/usage?' + new URLSearchParams(link))).data.totals, null);
  assert.equal((await call(env, '/api/health')).data.usage_migration, 'required');
});
