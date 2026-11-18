// "Ask Doorstep": a question-answering assistant that is only allowed to answer
// from facts this app already holds, and must cite them. Anything it cannot
// answer that way goes to the Doorstep team; their answers become facts too.
//
//   question ──▶ facts (gates now, game day, parking, closures, team
//                answers, how-to) ──▶ AI service /ask ──▶ answer + citations
//                                                     └─▶ "not in the facts"
//                                                          ──▶ team queue
//
// The model never sees anything it could cite that isn't in `facts`, and the
// Worker drops any citation that doesn't match a fact id. An answer with no
// valid citation is treated as "unknown" and escalated, not shown.

import {gateState, parkingState, footballContext} from './mobility.mjs';
import {callAi, aiConfigured} from './ai.mjs';

export const QUESTION_MAX = 300, ANSWER_MAX = 600;

const HOWTO = [
  ['howto:start', 'To set where you are, tap the map or press "Use my location". Then type a building and press "Find route".'],
  ['howto:drive', '"Drive + park" picks a parking structure whose gate is open now, gives driving directions to its vehicle entrance, then the walk from the structure\'s pedestrian exit to the building.'],
  ['howto:report', 'To report something blocking a path: press "Report blockage", tap the spot on the map, add a note and optionally a photo. Staff check reports before any route changes.'],
  ['howto:stairs', 'Tick "Avoid stairs" for a step-free walking route.'],
  ['howto:inside', 'When you reach the building entrance, "Continue inside" opens indoor directions to the room.'],
];

/** Everything the assistant may say, as short facts with ids and sources. */
export function collectFacts(context, when, {closures = [], answers = [], rules = []} = {}) {
  const facts = [], add = (id, text, source) => facts.push({id, text: String(text).slice(0, 500), source});
  add('now', `It is now ${context.time.campusISO(when)} on campus (Los Angeles time).`, 'clock');
  for (const g of gateState(context, when, rules)) {
    const v = g.vehicle || {}, ped = g.pedestrian || {};
    add('gate:' + g.id,
      `${g.name}${g.where ? ' (' + g.where + ')' : ''}: vehicle access is ${v.status || 'unknown'}${v.until ? ' until ' + v.until : ''}`
      + `${v.reason ? ' (' + v.reason + ')' : ''}. On foot: ${ped.status === 'open' ? 'open' + (ped.until ? ' until ' + ped.until : '') + (ped.observed ? ' (observed ' + ped.observed + ')' : '') : ped.status === 'closed' ? 'scheduled closed (it may be locked)' : ped.status === 'varies' ? 'may be closed right now (' + (ped.note || 'opening or closing time varies') + ')' : 'not stated by the source'}.`,
      g.basis === 'staff_confirmed' ? 'staff closure' : 'USC Transportation entrance hours');
  }
  const fb = footballContext(context.footballData, when);
  add('football:today', fb.game
    ? `Today is a USC home football game day${fb.game.opponent ? ' (vs ' + fb.game.opponent + ')' : ''}. As a precaution, driving routes avoid the campus-area parts of Exposition Blvd, Figueroa St, Martin Luther King Jr. Blvd and Flower St all day.`
    : `There is no USC home football game today.${fb.next ? ' The next home game is on ' + fb.next.date + '.' : ''}`,
    'USC Athletics schedule');
  for (const p of parkingState(context, when, rules)) {
    add('parking:' + p.id, `${p.name}${p.address ? ' (' + p.address + ')' : ''}: ${p.eligible ? 'can be driven into now' : 'not recommended now: ' + p.reason}`
      + ` Vehicle entrance via ${p.gate_name || p.gate}. ${p.note || ''} Spaces are not guaranteed.`, 'Doorstep parking data');
  }
  for (const c of closures) {
    if (c.status === 'approved')
      add('closure:' + c.id, `Closed for ${(c.modes || ['walking']).join(' and ')}: ${c.note || c.kind}, until ${c.ends}. Routes avoid it.`,
        c.source === 'official' ? 'staff' : 'staff-approved report');
    else if (c.status === 'unverified')
      add('report:' + c.id, `Unconfirmed public report: ${c.note || c.kind}. Not verified by staff; routes are not changed.`, 'public report');
  }
  for (const a of answers) add('answer:' + a.id, `Q: ${a.question}\nA: ${a.answer}`, 'Doorstep team answer' + (a.answered ? ', ' + a.answered : ''));
  for (const [id, text] of HOWTO) add(id, text, 'Doorstep help');
  return facts;
}

/** Whitelist the model's reply. Citations must be real fact ids. */
export function cleanAnswer(raw, factIds) {
  if (!raw || typeof raw !== 'object') return {answered: false, citations: []};
  const ids = new Set(factIds);
  const citations = [...new Set((Array.isArray(raw.citations) ? raw.citations : []).filter(c => typeof c === 'string' && ids.has(c)))].slice(0, 6);
  const answer = String(raw.answer ?? '').trim().slice(0, ANSWER_MAX);
  // No valid citation, no answer: escalate rather than show something unsupported.
  const answered = raw.answered === true && answer.length > 0 && citations.length > 0;
  const destination = typeof raw.destination === 'string' ? raw.destination.trim().slice(0, 80) : '';
  return {answered, answer: answered ? answer : '', citations: answered ? citations : [], destination};
}

export async function askModel(env, question, facts, now) {
  if (!aiConfigured(env)) return null;
  return callAi(env, '/ask', {question, facts, now}, 12_000);
}

// ---- storage ---------------------------------------------------------------
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

export async function recentAnswers(db, limit = 40) {
  if (!db) return [];
  const raw = await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM questions WHERE status='answered' ORDER BY answered_ms DESC LIMIT ?)")
    .bind(limit).first('data');
  return JSON.parse(raw || '[]');
}

export async function storeQuestion(db, question, now, campusISO, extra = {}) {
  const q = {id: newId(), question, status: 'open', asked: campusISO(now), ...extra};
  await db.prepare('INSERT INTO questions(id,status,created_ms,answered_ms,payload) VALUES(?,?,?,?,?)')
    .bind(q.id, q.status, now, q.status === 'answered' ? now : null, JSON.stringify(q)).run();
  return q;
}

export async function getQuestion(db, id) {
  const row = await db.prepare('SELECT payload FROM questions WHERE id=?').bind(id).first('payload');
  return row ? JSON.parse(row) : null;
}

export async function setAnswer(db, id, answer, now, campusISO) {
  const row = await db.prepare("UPDATE questions SET status='answered',answered_ms=?,payload=json_set(payload,'$.status','answered','$.answer',?,'$.answered',?) WHERE id=? RETURNING payload")
    .bind(now, answer, campusISO(now), id).first('payload');
  return row ? JSON.parse(row) : null;
}

export async function dismiss(db, id) {
  const row = await db.prepare("UPDATE questions SET status='dismissed',payload=json_set(payload,'$.status','dismissed') WHERE id=? RETURNING payload").bind(id).first('payload');
  return row ? JSON.parse(row) : null;
}

export async function staffList(db) {
  const raw = await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM questions WHERE status!='dismissed' ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_ms DESC LIMIT 60)").first('data');
  return JSON.parse(raw || '[]');
}

/** Small per-minute/day limit for /api/ask (it can call a paid model). */
export async function reserveAskQuota(db, now = Date.now()) {
  for (const [prefix, size, limit] of [['day', 86400000, 1500], ['minute', 60000, 40]]) {
    const slot = 'ask:' + prefix + ':' + Math.floor(now / size);
    const count = await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET count=count+1 WHERE count<? RETURNING count')
      .bind(slot, now + size * 2, limit).first('count');
    if (!count) return false;
  }
  return true;
}
