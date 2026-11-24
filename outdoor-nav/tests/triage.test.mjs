// AI triage: the model suggests, staff decide. A fake triage service stands in
// for the Replit app, so these run with no network and no model.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import {clean, checkPhoto, PHOTO_MAX_CHARS} from '../cloudflare/triage.mjs';

class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    for (const name of ['0001_closures.sql', '0002_mobility.sql'])
      this.db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  prepare(sql) {
    let params = []; const self = this;
    return {bind(...v) { params = v; return this; },
      async first(col) { const row = self.db.prepare(sql).get(...params); return row ? (col ? row[col] : row) : null; },
      async run() { return self.db.prepare(sql).run(...params); }};
  }
}
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const env = (extra = {}) => ({DB: new D1(), ADMIN_TOKEN: 'staff', PUBLIC_REPORTS_ENABLED: 'true',
  AI_URL: 'https://ai.example.test/', AI_SECRET: 's3cret', ...extra});
async function call(e, path, method = 'GET', body, token) {
  const r = await worker.fetch(new Request('https://x.test' + path, {method,
    headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(token ? {'X-Admin-Token': token} : {})},
    body: body === undefined ? undefined : JSON.stringify(body)}), e);
  return {status: r.status, data: await r.json()};
}
// Replace global fetch with a fake triage service for one test.
function fakeTriage(t, respond) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({url: String(url), init, body: JSON.parse(init.body)}); return respond(calls.at(-1)); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const json = obj => new Response(JSON.stringify(obj), {status: 200, headers: {'Content-Type': 'application/json'}});
const report = {lat: 34.020, lon: -118.287, note: 'fence across the path'};

test('a suggestion is stored with the report but never approves it; the photo is not stored', async t => {
  const calls = fakeTriage(t, () => json({category: 'construction', blocks_walking: true, summary: 'Construction fence across the walkway',
    confidence: 0.9, suggested_radius_m: 20, suggested_hours: 3}));
  const e = env(), r = await call(e, '/api/closures', 'POST', {...report, photo: PHOTO});
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'unverified');
  assert.equal(r.data.ai.category, 'construction');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ai.example.test/triage');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer s3cret');
  assert.equal(calls[0].body.photo, PHOTO);
  const listed = (await call(e, '/api/closures', 'GET', undefined, 'staff')).data;   // staff see the suggestion; the public doesn't
  assert.equal((await call(e, '/api/closures')).data[0].ai, undefined);
  assert.equal(listed[0].ai.summary, 'Construction fence across the walkway');
  assert.equal(JSON.stringify(listed).includes('/9j/'), false, 'photo must not be persisted');
});

test('if the triage service fails, the report still goes in, without a suggestion', async t => {
  fakeTriage(t, () => { throw new Error('connection refused'); });
  const r = await call(env(), '/api/closures', 'POST', report);
  assert.equal(r.status, 201);
  assert.equal(r.data.ai.status, 'unavailable');
  assert.equal(r.data.status, 'unverified');
});

test('not configured: no call is made and no ai field appears', async t => {
  const calls = fakeTriage(t, () => json({}));
  const r = await call(env({AI_URL: '', AI_SECRET: ''}), '/api/closures', 'POST', report);
  assert.equal(r.status, 201);
  assert.equal(calls.length, 0);
  assert.equal('ai' in r.data, false);
  assert.equal((await call(env({AI_URL: ''}), '/api/health')).data.ai_service, false);
  assert.equal((await call(env(), '/api/health')).data.ai_service, true);
});

test('staff reports skip triage', async t => {
  const calls = fakeTriage(t, () => json({category: 'construction'}));
  const r = await call(env(), '/api/closures', 'POST', report, 'staff');
  assert.equal(r.data.status, 'approved');
  assert.equal(calls.length, 0);
});

test('whatever the model returns is whitelisted and clamped', () => {
  const ai = clean({category: 'aliens', suggested_radius_m: 9999, confidence: 7, suggested_hours: -3,
    duplicate_of: 'someone-else', summary: 'x'.repeat(500), blocks_walking: 'yes'}, ['abc']);
  assert.deepEqual([ai.category, ai.suggested_radius_m, ai.confidence, ai.suggested_hours, ai.duplicate_of, ai.summary.length, ai.blocks_walking],
    ['unclear', 60, 1, 0.5, null, 120, false]);
  assert.equal(clean('not an object').status, 'invalid');
  assert.equal(clean({duplicate_of: 'abc'}, ['abc']).duplicate_of, 'abc');
});

test('nearby open reports are sent so the model can flag a duplicate', async t => {
  let first = null;
  const calls = fakeTriage(t, ({body}) => json(body.nearby.length
    ? {category: 'construction', duplicate_of: body.nearby[0].id} : {category: 'construction'}));
  const e = env();
  first = (await call(e, '/api/closures', 'POST', report)).data;
  const second = (await call(e, '/api/closures', 'POST', {...report, lat: 34.0201})).data;   // ~11 m away
  assert.equal(calls[1].body.nearby[0].id, first.id);
  assert.equal(second.ai.duplicate_of, first.id);
});

test('"approve as suggested" applies the AI radius and duration, and needs a staff token', async t => {
  fakeTriage(t, () => json({category: 'event_setup', suggested_radius_m: 25, suggested_hours: 2}));
  const e = env(), c = (await call(e, '/api/closures', 'POST', report)).data, p = '/api/closures/' + c.id + '/approve';
  assert.equal((await call(e, p, 'POST', {apply_ai: true})).status, 403);
  const ok = (await call(e, p, 'POST', {apply_ai: true}, 'staff')).data;
  assert.equal(ok.status, 'approved');
  assert.equal(ok.radius_m, 25);
  assert.equal(ok.ai.applied, true);
  const hours = (Date.parse(ok.ends) - Date.parse(ok.created)) / 3600000;
  assert.ok(Math.abs(hours - 2) < 0.01, hours);
});

test('"approve as suggested" refuses a report with no suggestion', async t => {
  fakeTriage(t, () => { throw new Error('down'); });
  const e = env(), c = (await call(e, '/api/closures', 'POST', report)).data;
  assert.equal((await call(e, '/api/closures/' + c.id + '/approve', 'POST', {apply_ai: true}, 'staff')).status, 409);
});

test('photo checks: type, size, and body limit', async t => {
  fakeTriage(t, () => json({}));
  assert.equal(checkPhoto(null), null);
  assert.ok(checkPhoto('data:text/html;base64,PGI+').error);
  assert.ok(checkPhoto('data:image/jpeg;base64,' + 'A'.repeat(PHOTO_MAX_CHARS)).error);
  assert.equal((await call(env(), '/api/closures', 'POST', {...report, photo: 'javascript:alert(1)'})).status, 400);
  assert.equal((await call(env(), '/api/closures', 'POST', {...report, photo: 'data:image/jpeg;base64,' + 'A'.repeat(PHOTO_MAX_CHARS)})).status, 400);
  assert.equal((await call(env(), '/api/closures', 'POST', {...report, photo: 'data:image/jpeg;base64,' + 'A'.repeat(460000)})).status, 413);
  // other endpoints keep the small limit
  assert.equal((await call(env(), '/api/outdoor/route', 'POST', {from: {lat: 34.02, lon: -118.287}, to: 'x'.repeat(20000)})).status, 413);
});
