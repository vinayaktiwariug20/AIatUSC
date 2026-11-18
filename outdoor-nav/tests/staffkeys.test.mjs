// Staff keys: named, revocable, fewer powers than the team admin token.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import {makeKey, normalizeKey, checkOwnKey, rollWords} from '../cloudflare/staffkeys.mjs';
import {WORDS} from '../cloudflare/words.mjs';

const ALL = ['0001_closures.sql', '0002_mobility.sql', '0003_questions.sql', '0004_usage.sql', '0005_parking_status.sql', '0006_staff_keys.sql'];
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
async function call(env, path, {method = 'GET', body, token, ip = '203.0.113.9'} = {}) {
  const headers = {'CF-Connecting-IP': ip}; if (body) headers['Content-Type'] = 'application/json'; if (token) headers['X-Admin-Token'] = token;
  const r = await worker.fetch(new Request('https://x.test' + path, {method, headers, body: body ? JSON.stringify(body) : undefined}), env);
  return {status: r.status, data: r.status === 204 ? null : await r.json()};
}
const newEnv = () => ({DB: new D1(), ADMIN_TOKEN: ADMIN});
const GATE_RULE = {kind: 'gate', gate: 'mcclintock', starts: '2026-11-17T12:00', ends: '2026-11-17T13:00', note: 'test'};

test('keys are five real words from the EFF list, without plurals or -ed/-ing forms', () => {
  const k = makeKey().split(' ');
  assert.equal(k.length, 5); assert.ok(k.every(w => WORDS.includes(w)));
  assert.notEqual(makeKey(), makeKey());
  assert.equal(WORDS.length, 1238); assert.equal(new Set(WORDS).size, WORDS.length);
  for (const w of ['acts', 'boots', 'baked', 'going', 'yo-yo', 'april', 'ebay', 'mardi']) assert.ok(!WORDS.includes(w), w);
  for (const w of ['acorn', 'chess', 'atlas', 'thing']) assert.ok(WORDS.includes(w), w);
  const roll = rollWords(10); assert.equal(roll.length, 10); assert.equal(new Set(roll).size, 10);
  assert.equal(normalizeKey(' Tamoru-Kebisa  lodupe VINEKO '), 'tamorukebisalodupevineko');
});

test('a staff key can post and lift closures and parking statuses, and is named on them', async () => {
  const env = newEnv();
  const {data: made, status} = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Transportation dispatch'}, token: ADMIN});
  assert.equal(status, 201); assert.equal(made.name, 'Transportation dispatch');
  const typed = made.key.toUpperCase().replaceAll(' ', '-');                      // autocapitalised, hyphenated: still fine
  assert.deepEqual((await call(env, '/api/whoami', {token: typed})).data, {role: 'staff', name: 'Transportation dispatch'});
  const rule = await call(env, '/api/mobility/rules', {method: 'POST', body: GATE_RULE, token: typed});
  assert.equal(rule.status, 201); assert.equal(rule.data.by, 'Transportation dispatch');
  const parking = await call(env, '/api/mobility/rules', {method: 'POST', token: made.key,
    body: {kind: 'parking', parking: 'downey', applies: 'everyone', status: 'full', starts: '2026-11-17T12:00', ends: '2026-11-17T15:00'}});
  assert.equal(parking.status, 201); assert.equal(parking.data.by, 'Transportation dispatch');
  assert.equal((await call(env, '/api/mobility/rules/' + rule.data.id, {method: 'DELETE', token: made.key})).status, 200);
});

test('a staff key cannot read stats, answer organizer questions or manage keys', async () => {
  const env = newEnv();
  const {data: made} = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Desk'}, token: ADMIN});
  assert.equal((await call(env, '/api/stats', {token: made.key})).status, 403);
  assert.equal((await call(env, '/api/questions', {token: made.key})).status, 403);
  assert.equal((await call(env, '/api/staff-keys', {token: made.key})).status, 403);
  assert.equal((await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'x'}, token: made.key})).status, 403);
  assert.equal((await call(env, '/api/stats', {token: ADMIN})).status, 200);
});

test('revoking a key stops it at once; the list never shows keys or hashes', async () => {
  const env = newEnv();
  const {data: made} = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Game-day attendant'}, token: ADMIN});
  await call(env, '/api/whoami', {token: made.key});
  const list = (await call(env, '/api/staff-keys', {token: ADMIN})).data;
  assert.equal(list.length, 1); assert.ok(list[0].last_used_ms);
  assert.ok(!JSON.stringify(list).includes(made.key.split(' ')[0]) && !('key_hash' in list[0]));
  assert.equal((await call(env, '/api/staff-keys/' + made.id, {method: 'DELETE', token: ADMIN})).status, 200);
  assert.equal((await call(env, '/api/mobility/rules', {method: 'POST', body: GATE_RULE, token: made.key})).status, 403);
  assert.equal((await call(env, '/api/whoami', {token: made.key})).data.role, null);
});

test('valid staff keys never count towards the wrong-token lockout', async () => {
  const env = newEnv();
  const {data: made} = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Desk'}, token: ADMIN});
  for (let i = 0; i < 15; i++) assert.equal((await call(env, '/api/mobility/rules?at=2026-11-17T12:00', {token: made.key})).status, 200);
  for (let i = 0; i < 10; i++) await call(env, '/api/whoami', {token: 'wrong ' + i, ip: '198.51.100.1'});
  assert.equal((await call(env, '/api/mobility/rules', {token: made.key, ip: '198.51.100.1'})).status, 429);   // that connection is locked
  assert.equal((await call(env, '/api/mobility/rules?at=2026-11-17T12:00', {token: made.key})).status, 200);    // others aren't
});

test('before migration 0006: the admin token still works and creating a key says what is missing', async () => {
  const env = {DB: new D1(ALL.slice(0, 5)), ADMIN_TOKEN: ADMIN};
  assert.equal((await call(env, '/api/mobility/rules', {method: 'POST', body: GATE_RULE, token: ADMIN})).status, 201);
  const r = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Desk'}, token: ADMIN});
  assert.equal(r.status, 503); assert.match(r.data.error, /migration 0006/);
  assert.equal((await call(env, '/api/whoami', {token: 'some made up words here'})).data.role, null);
});

test('your own key: accepted when long enough, refused when weak, guessable or reused', async () => {
  assert.equal(checkOwnKey('acorn tidal maple shrug'), null);
  assert.match(checkOwnKey('cat dog sun hat'), /16 letters/);
  assert.match(checkOwnKey('acorn acorn maple shrug'), /only once/);
  assert.match(checkOwnKey('fight on trojans forever'), /guessable/);
  assert.match(checkOwnKey(ADMIN, ADMIN), /admin token|guessable/);
  const env = newEnv();
  const made = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Desk', key: '  Acorn-Tidal  maple SHRUG '}, token: ADMIN});
  assert.equal(made.status, 201); assert.equal(made.data.key, 'acorn tidal maple shrug');
  assert.equal((await call(env, '/api/whoami', {token: 'acorn tidal maple shrug'})).data.name, 'Desk');
  const again = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Other', key: 'acorn tidal maple shrug'}, token: ADMIN});
  assert.equal(again.status, 400); assert.match(again.data.error, /already in use/);
  assert.equal((await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Weak', key: 'cat dog sun hat'}, token: ADMIN})).status, 400);
});

test('rolling words is admin-only; only a revoked key can be removed', async () => {
  const env = newEnv();
  const roll = await call(env, '/api/staff-keys/roll?n=8', {token: ADMIN});
  assert.equal(roll.status, 200); assert.equal(roll.data.words.length, 8);
  const {data: made} = await call(env, '/api/staff-keys', {method: 'POST', body: {name: 'Oops'}, token: ADMIN});
  assert.equal((await call(env, '/api/staff-keys/roll', {token: made.key})).status, 403);
  assert.equal((await call(env, '/api/staff-keys/' + made.id + '?remove=1', {method: 'DELETE', token: ADMIN})).status, 404);   // still working
  await call(env, '/api/staff-keys/' + made.id, {method: 'DELETE', token: ADMIN});
  assert.equal((await call(env, '/api/staff-keys/' + made.id + '?remove=1', {method: 'DELETE', token: ADMIN})).status, 200);
  assert.deepEqual((await call(env, '/api/staff-keys', {token: ADMIN})).data, []);
});
