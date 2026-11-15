// "Ask Doorstep": answers only from cited facts; otherwise organizers answer,
// and their answers become facts. A fake AI service stands in for the Replit app.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import {cleanAnswer} from '../cloudflare/assistant.mjs';

class D1 {
  constructor(migrations = ['0001_closures.sql', '0002_mobility.sql', '0003_questions.sql']) {
    this.db = new DatabaseSync(':memory:');
    for (const name of migrations) this.db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  prepare(sql) {
    let params = []; const self = this;
    return {bind(...v) { params = v; return this; },
      async first(col) { const row = self.db.prepare(sql).get(...params); return row ? (col ? row[col] : row) : null; },
      async run() { return self.db.prepare(sql).run(...params); }};
  }
}
const env = (extra = {}) => ({DB: new D1(), ADMIN_TOKEN: 'staff', PUBLIC_REPORTS_ENABLED: 'true',
  AI_URL: 'https://ai.example.test', AI_SECRET: 's3cret', ...extra});
async function call(e, path, method = 'GET', body, token) {
  const r = await worker.fetch(new Request('https://x.test' + path, {method,
    headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(token ? {'X-Admin-Token': token} : {})},
    body: body === undefined ? undefined : JSON.stringify(body)}), e);
  return {status: r.status, data: await r.json()};
}
function fakeAi(t, respond) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { const c = {url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization}; calls.push(c);
    return new Response(JSON.stringify(respond(c)), {status: 200, headers: {'Content-Type': 'application/json'}}); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

test('a cited answer is returned with its sources; facts include live gate status', async t => {
  const calls = fakeAi(t, ({body}) => {
    const gate = body.facts.find(f => f.id === 'gate:watt');
    return {answered: true, answer: 'Watt Way is closed to cars right now.', citations: [gate.id], destination: 'Doheny'};
  });
  const r = await call(env(), '/api/ask', 'POST', {question: 'Is the Watt Way gate open?'});
  assert.equal(r.status, 200);
  assert.equal(r.data.answered, true);
  assert.equal(r.data.sources[0].id, 'gate:watt');
  assert.equal(r.data.sources[0].source, 'USC Transportation entrance hours');
  assert.equal(r.data.destination.id, 'edward-l-doheny-junior-memorial-library');
  assert.equal(calls[0].url, 'https://ai.example.test/ask');
  assert.equal(calls[0].auth, 'Bearer s3cret');
  for (const id of ['now', 'football:today', 'parking:downey', 'howto:start']) assert.ok(calls[0].body.facts.some(f => f.id === id), id);
});

test('an answer that cites nothing real is NOT shown; the question goes to organizers', async t => {
  fakeAi(t, () => ({answered: true, answer: 'Free pizza in room 101!', citations: ['made-up-fact']}));
  const e = env(), r = await call(e, '/api/ask', 'POST', {question: 'Is there food at the event?'});
  assert.equal(r.status, 201);
  assert.equal(r.data.answered, false);
  assert.match(r.data.question_id, /^[0-9a-f]{16}$/);
  const q = (await call(e, '/api/questions/' + r.data.question_id)).data;
  assert.equal(q.status, 'open');
  assert.equal(q.answer, null);
});

test('an organizer answer reaches the asker and becomes a fact for the next person', async t => {
  const calls = fakeAi(t, ({body}) => {
    const a = body.facts.find(f => f.id.startsWith('answer:'));
    return a ? {answered: true, answer: 'Yes, pizza at 7 pm.', citations: [a.id]} : {answered: false};
  });
  const e = env();
  const first = (await call(e, '/api/ask', 'POST', {question: 'Is there food at the event?'})).data;
  assert.equal(first.answered, false);
  const p = '/api/questions/' + first.question_id + '/answer';
  assert.equal((await call(e, p, 'POST', {answer: 'Pizza at 7 pm in the lobby.'})).status, 403);   // staff only
  assert.equal((await call(e, p, 'POST', {answer: 'Pizza at 7 pm in the lobby.'}, 'staff')).data.status, 'answered');
  const polled = (await call(e, '/api/questions/' + first.question_id)).data;
  assert.equal(polled.status, 'answered');
  assert.equal(polled.answer, 'Pizza at 7 pm in the lobby.');
  const second = (await call(e, '/api/ask', 'POST', {question: 'Will there be food?'})).data;
  assert.equal(second.answered, true);
  assert.equal(second.sources[0].source.startsWith('organizer answer'), true);
  assert.ok(calls.at(-1).body.facts.some(f => f.text.includes('Pizza at 7 pm')));
});

test('organizers can add FAQ answers up front, list and dismiss questions; all staff-only', async t => {
  fakeAi(t, () => ({answered: false}));
  const e = env();
  assert.equal((await call(e, '/api/questions')).status, 403);
  const faq = (await call(e, '/api/questions', 'POST', {question: 'Where is check-in?', answer: 'Lobby, by the main doors.'}, 'staff')).data;
  assert.equal(faq.status, 'answered');
  const q = (await call(e, '/api/ask', 'POST', {question: 'Is parking validated?'})).data;
  const list = (await call(e, '/api/questions', 'GET', undefined, 'staff')).data;
  assert.equal(list[0].id, q.question_id);                 // open questions first
  assert.equal((await call(e, '/api/questions/' + q.question_id + '/dismiss', 'POST', {}, 'staff')).data.status, 'dismissed');
  assert.equal((await call(e, '/api/questions/' + q.question_id)).status, 404);
});

test('without an AI service every question goes to organizers, with a clear message', async t => {
  const calls = fakeAi(t, () => ({}));
  const r = await call(env({AI_URL: '', AI_SECRET: ''}), '/api/ask', 'POST', {question: 'When does the talk start?'});
  assert.equal(r.status, 201);
  assert.equal(r.data.answered, false);
  assert.match(r.data.message, /unavailable/);
  assert.equal(calls.length, 0);
});

test('input limits and the missing-migration message', async t => {
  fakeAi(t, () => ({answered: false}));
  assert.equal((await call(env(), '/api/ask', 'POST', {question: ''})).status, 400);
  assert.equal((await call(env(), '/api/ask', 'POST', {question: 'x'.repeat(301)})).status, 400);
  const old = env({DB: new D1(['0001_closures.sql', '0002_mobility.sql'])});
  const r = await call(old, '/api/ask', 'POST', {question: 'Hello?'});
  assert.equal(r.status, 503);
  assert.match(r.data.error, /migration 0003/);
  assert.equal((await call(old, '/api/health')).data.questions_migration, 'required');
});

test('cleanAnswer keeps only real citations and requires at least one', () => {
  assert.deepEqual(cleanAnswer({answered: true, answer: 'x', citations: ['a', 'zzz', 'a']}, ['a', 'b']).citations, ['a']);
  assert.equal(cleanAnswer({answered: true, answer: 'x', citations: []}, ['a']).answered, false);
  assert.equal(cleanAnswer({answered: true, answer: '', citations: ['a']}, ['a']).answered, false);
  assert.equal(cleanAnswer(null, ['a']).answered, false);
});
