// Parking prices from the Staff screen: hourly, all day, event and free.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import {WalkRouter} from '../cloudflare/router.mjs';
import {parseTime, campusISO, gateStatus} from '../cloudflare/api.mjs';
import {rateText} from '../cloudflare/mobility.mjs';
import {collectFacts} from '../cloudflare/assistant.mjs';

const ALL = ['0001_closures.sql', '0002_mobility.sql', '0003_questions.sql', '0004_usage.sql', '0005_parking_status.sql', '0006_staff_keys.sql', '0007_parking_rates.sql'];
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
const post = (env, body, token) => call(env, '/api/mobility/rules', {method: 'POST', body: {kind: 'rate', ...body}, token});
const structure = async (env, at, id, permit) => (await call(env, '/api/mobility?at=' + at + (permit ? '&permit=' + permit : ''))).data.parking.find(p => p.id === id);
const YEAR = {starts: '2026-08-01T00:00', ends: '2027-07-31T00:00'};

test('standing rates show on the structure for drivers, newest of each option', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  assert.equal((await post(env, {parking: 'downey', option: 'hourly', price: 3, max: 18, pay: 'text2park', ...YEAR})).status, 201); await pause();
  assert.equal((await post(env, {parking: 'downey', option: 'daily', price: 15, ...YEAR})).status, 201); await pause();
  assert.equal((await post(env, {parking: 'downey', option: 'daily', price: 18, ...YEAR})).status, 201);   // a correction
  const d = await structure(env, '2026-11-17T10:00', 'downey');
  assert.deepEqual(d.rates.map(rateText), ['$3/hour (max $18/day) · pay by Text2Park (+$0.50 fee)', 'All day $18']);
  assert.equal(d.rates_apply, true);
  assert.equal((await structure(env, '2026-11-17T10:00', 'downey', 'downey')).rates_apply, false);   // their permit covers it
  const m = await structure(env, '2026-11-17T10:00', 'mccarthy');   // nothing posted: USC Transportation's published rates
  assert.deepEqual(m.rates.map(rateText), ['$4/hour · pay by Text2Park (+$0.50 fee) or pay station · 1 hour max', 'All day $20 · pay by Text2Park (+$0.50 fee) or pay station']);
  assert.ok(m.rates.every(r => r.source === 'published')); assert.match(m.rates_source.url, /transnet\.usc\.edu/);
  assert.equal(d.rates_source, null); assert.equal(d.published_rates, undefined);
  assert.equal(d.rates[0].by, undefined);   // who posted it stays on the Staff screen
});

test('an event rate replaces the others while it applies, then they come back', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  await post(env, {parking: 'royal', option: 'hourly', price: 3, ...YEAR}); await pause();
  await post(env, {parking: 'royal', option: 'event', price: 30, label: 'Football vs UCLA', pay: 'booth', starts: '2026-11-21T06:00', ends: '2026-11-21T23:59'});
  assert.deepEqual((await structure(env, '2026-11-21T12:00', 'royal')).rates.map(rateText), ['Football vs UCLA: Event rate $30 · pay by booth']);
  assert.deepEqual((await structure(env, '2026-11-22T12:00', 'royal')).rates.map(rateText), ['$3/hour', 'All day $20 · pay by Text2Park (+$0.50 fee) or pay station']);   // staff hourly, published daily
});

test('an event rate can offer a lower validated price for people not at the event', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'}, day = {starts: '2026-11-19T06:00', ends: '2026-11-19T23:59'};
  const r = await post(env, {parking: 'figueroa', option: 'event', price: 40, label: 'Concert at the Shrine', validated_price: 20, validated_how: 'ask the attendant at the entrance', ...day});
  assert.equal(r.status, 201);
  assert.deepEqual((await structure(env, '2026-11-19T18:00', 'figueroa')).rates.map(rateText),
    ['Concert at the Shrine: Event rate $40; not here for the event: $20 all day with a validation code (ask the attendant at the entrance)']);
  assert.match((await post(env, {parking: 'figueroa', option: 'event', price: 40, validated_price: 40, ...day})).data.error, /lower than the event price/);
  const hourly = (await post(env, {parking: 'figueroa', option: 'hourly', price: 3, validated_price: 1, ...day})).data;
  assert.equal(hourly.validated, null);   // only event rates have one
});

test('weekly rates apply only on their days and hours', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  await post(env, {parking: 'mccarthy', option: 'free', days: ['Sat', 'Sun'], from: '00:00', to: '24:00', note: 'weekends', ...YEAR});
  assert.deepEqual((await structure(env, '2026-11-22T12:00', 'mccarthy')).rates.map(rateText), ['Free · weekends']);
  assert.ok((await structure(env, '2026-11-23T12:00', 'mccarthy')).rates.every(r => r.source === 'published'));   // Monday: back to the published rates
});

test('bad rates are refused, and only staff can post or remove them', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'}, ok = {parking: 'downey', option: 'hourly', price: 3, ...YEAR};
  for (const [bad, why] of [[{option: 'weekly'}, /hourly, all day/], [{price: -1}, /dollar amount/], [{price: 2.555}, /dollar amount/], [{price: ''}, /dollar amount/],
    [{max: 2}, /at least the hourly/], [{pay: 'cash'}, /way to pay/], [{parking: 'nowhere'}, /Unknown parking/], [{ends: '2028-01-01T00:00'}, /400 days/]]) {
    const r = await post(env, {...ok, ...bad});
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.data.error, why);
  }
  assert.equal((await post(env, ok, 'wrong')).status, 403);
  const made = (await post(env, ok)).data;
  const listed = (await call(env, '/api/mobility/rules?at=2026-11-17T10:00')).data;
  assert.ok(listed.some(r => r.id === made.id && r.kind === 'rate'));
  assert.equal((await call(env, '/api/mobility/rules/' + made.id, {method: 'DELETE', token: 'wrong'})).status, 403);
  assert.equal((await call(env, '/api/mobility/rules/' + made.id, {method: 'DELETE'})).status, 200);
  assert.deepEqual((await structure(env, '2026-11-17T10:00', 'downey')).rates, []);
});

test('before migration 0007, posting says so and drivers see no rates', async () => {
  const env = {DB: new D1(ALL.slice(0, 6)), ADMIN_TOKEN: 'staff'};
  const r = await post(env, {parking: 'downey', option: 'daily', price: 18, ...YEAR});
  assert.equal(r.status, 503); assert.match(r.data.error, /migration 0007/);
  assert.deepEqual((await structure(env, '2026-11-17T10:00', 'downey')).rates, []);
});

test('Ask Doorstep can answer from posted rates', async () => {
  const rules = [{kind: 'rate', parking: 'downey', option: 'daily', price: 18, max: null, pay: 'text2park', label: null, note: '', starts_ms: 0, ends_ms: 9e15, created_ms: 1, updated: '2026-11-19T09:00:00-08:00', ends: '2300-01-01T00:00'}];
  const facts = collectFacts(context, parseTime('2026-11-19T10:00'), {closures: [], answers: [], rules});
  const f = facts.find(x => x.id === 'rate:downey');
  assert.match(f.text, /Downey Way Parking Structure prices now.*All day \$18 · pay by Text2Park/);
});

test("published rates follow USC Transportation's day and time windows", async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'}, at = async (when, id) => (await structure(env, when, id)).rates.map(rateText);
  assert.deepEqual(await at('2026-11-17T10:00', 'downey'), []);   // Tuesday morning: no visitor sales at Downey
  assert.match((await at('2026-11-17T13:00', 'downey'))[0], /^All day \$20/);
  assert.match((await at('2026-11-21T09:00', 'downey'))[0], /^All day \$20/);   // Saturday: all day
  assert.deepEqual(await at('2026-11-17T13:00', 'royal'), ['All day $20 · pay by Text2Park (+$0.50 fee) or pay station']);
  assert.equal((await at('2026-11-21T13:00', 'royal')).length, 2);   // hourly on weekends too
  assert.deepEqual(await at('2026-11-17T13:00', 'lot2'), ['$5/hour · pay by Text2Park (+$0.50 fee) · 2 hours max']);
});

test('a staff Free rate replaces the published prices', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  await post(env, {parking: 'figueroa', option: 'free', note: 'open house', starts: '2026-11-21T00:00', ends: '2026-11-22T00:00'});
  assert.deepEqual((await structure(env, '2026-11-21T12:00', 'figueroa')).rates.map(rateText), ['Free · open house']);
});

test('Lot V: public, weekdays until 8 pm, $5/hour up to 4 hours; the dental note points to Shrine', async () => {
  const env = {DB: new D1(), ADMIN_TOKEN: 'staff'};
  const tue = await structure(env, '2026-11-17T10:00', 'lotv');
  assert.equal(tue.eligible, true);
  assert.deepEqual(tue.rates.map(rateText), ['$5/hour (max $20/day) · pay by Text2Park (+$0.50 fee) · up to 4 hours; longer stays are charged the $20 daily rate']);
  assert.match(tue.note, /Shrine/);
  assert.equal((await structure(env, '2026-11-17T21:00', 'lotv')).eligible, false);
  assert.equal((await structure(env, '2026-11-21T10:00', 'lotv')).eligible, false);   // Saturday
});
