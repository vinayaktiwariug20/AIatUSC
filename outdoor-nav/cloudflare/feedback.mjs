// Feedback from people using Doorstep, read by staff in the Staff panel.
// Two ways in: "Was this route right? No" on a route card (the route is attached so the
// team can reproduce it), and "Send feedback" in the footer.
// Nothing that identifies the sender is kept: there is no name or contact field, and a
// route's start is rounded to 3 decimal places (about 100 m).
export const FEEDBACK_MAX = 600, TRYING_MAX = 200, DONE_KEEP_MS = 90 * 86400000;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const clean = v => String(v ?? '').trim().replace(/\s+/g, ' ');
const round3 = x => Math.round(x * 1000) / 1000;
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

export const feedbackReady = async db =>
  await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'").first('name') === 'feedback';

/** Validate what the page sent. Returns {item} or {error}. Unknown fields are dropped. */
export function cleanFeedback(b) {
  const kind = b?.kind, message = clean(b?.message);
  if (kind !== 'route' && kind !== 'general') return {error: 'Unknown kind of feedback.'};
  if (message.length > FEEDBACK_MAX) return {error: 'Please keep it under ' + FEEDBACK_MAX + ' characters.'};
  if (kind === 'general') {
    const trying = clean(b.trying);
    if (!message) return {error: 'Write something first.'};
    if (trying.length > TRYING_MAX) return {error: 'Please keep "what you were trying to do" under ' + TRYING_MAX + ' characters.'};
    return {item: {kind, message, ...(trying ? {trying} : {})}};
  }
  const r = b.route || {}, route = {mode: r.mode === 'driving' ? 'driving' : 'walking'};
  for (const k of ['to', 'parking', 'gate', 'entrance']) if (typeof r[k] === 'string' && ID.test(r[k])) route[k] = r[k];
  for (const k of ['to_name', 'parking_name', 'gate_name']) if (typeof r[k] === 'string') { const v = clean(r[k]).slice(0, 80); if (v) route[k] = v; }
  if (Number.isFinite(r.minutes) && r.minutes >= 0 && r.minutes < 1000) route.minutes = Math.round(r.minutes * 10) / 10;
  const lat = Number(r.from?.lat), lon = Number(r.from?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) route.from = [round3(lat), round3(lon)];
  if (typeof r.at === 'string' && /^[0-9T:+-]{10,25}$/.test(r.at)) route.at = r.at;
  if (r.step_free === true) route.step_free = true;
  return {item: {kind, ...(message ? {message} : {}), route}};
}

export async function storeFeedback(db, item, now, campusISO) {
  const f = {id: newId(), status: 'open', sent: campusISO(now), ...item};
  await db.prepare('INSERT INTO feedback(id,status,created_ms,done_ms,payload) VALUES(?,?,?,?,?)')
    .bind(f.id, f.status, now, null, JSON.stringify(f)).run();
  await db.prepare("DELETE FROM feedback WHERE status='done' AND done_ms<?").bind(now - DONE_KEEP_MS).run();
  return f;
}

/** Open items first, newest first; then the 50 most recently done. */
export async function feedbackList(db) {
  const rows = async sql => JSON.parse(await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (" + sql + ")").first('data') || '[]');
  return {open: await rows("SELECT payload FROM feedback WHERE status='open' ORDER BY created_ms DESC LIMIT 200"),
          done: await rows("SELECT payload FROM feedback WHERE status='done' ORDER BY done_ms DESC LIMIT 50")};
}

export async function setFeedbackStatus(db, id, status, now) {
  const row = await db.prepare("UPDATE feedback SET status=?,done_ms=?,payload=json_set(payload,'$.status',?) WHERE id=? RETURNING payload")
    .bind(status, status === 'done' ? now : null, status, id).first('payload');
  return row ? JSON.parse(row) : null;
}

/** Shared limits so nobody can fill the inbox: 20 a minute, 300 a day, across everyone. */
export async function reserveFeedbackQuota(db, now = Date.now()) {
  for (const [prefix, size, limit] of [['day', 86400000, 300], ['minute', 60000, 20]]) {
    const slot = 'feedback:' + prefix + ':' + Math.floor(now / size);
    const count = await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET count=count+1 WHERE count<? RETURNING count')
      .bind(slot, now + size * 2, limit).first('count');
    if (!count) return false;
  }
  return true;
}
