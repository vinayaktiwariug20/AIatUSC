// Anonymous usage counts for organizers: "37 people opened your link, 31 reached
// the door". Daily totals per event link and nothing else -- no IP, no device or
// user id, no location, no cookies. See /privacy/.

export const USAGE_KINDS = ['open', 'route', 'arrive', 'inside', 'ask'];

/** Short, stable key for an event link: same building + room + event name. */
export async function linkKey(buildingId, room = '', event = '') {
  const text = JSON.stringify([buildingId, String(room).trim(), String(event).replace(/\s+/g, ' ').trim().toLowerCase()]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const usageReady = async db =>
  await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_counts'").first('name') === 'usage_counts';

export async function countUsage(db, day, link, kind) {
  await db.prepare('INSERT INTO usage_counts(day,link,kind,count) VALUES(?,?,?,1) ON CONFLICT(day,link,kind) DO UPDATE SET count=count+1')
    .bind(day, link, kind).run();
}

export async function usageTotals(db, link, sinceDay) {
  const totals = Object.fromEntries(USAGE_KINDS.map(k => [k, 0]));
  const raw = await db.prepare("SELECT COALESCE(json_group_array(json_object('kind',kind,'n',n)),'[]') AS data FROM (SELECT kind, SUM(count) AS n FROM usage_counts WHERE link=? AND day>=? GROUP BY kind)")
    .bind(link, sinceDay).first('data');
  for (const r of JSON.parse(raw || '[]')) if (r.kind in totals) totals[r.kind] = r.n;
  return totals;
}

/** Keeps a misbehaving client from inflating counts: 1,200 events a minute overall. */
export async function reserveUsageQuota(db, now = Date.now()) {
  const slot = 'usage:minute:' + Math.floor(now / 60000);
  const n = await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET count=count+1 WHERE count<? RETURNING count')
    .bind(slot, now + 120000, 1200).first('count');
  return Boolean(n);
}

// ---- Site-wide counts, for the team ------------------------------------------
// Same table, same rules: a date, the reserved key "_site", what happened, a
// count. Each kind is counted at most once per visit by the page, so the numbers
// read as "visits that did X", never as a trail of one person's actions.
export const SITE = '_site';
export const SITE_KINDS = [
  'visit', 'visit_event_link',                                   // who comes
  'route_walk', 'route_drive', 'step_free',                      // what for
  'start_gps', 'start_address', 'start_place', 'start_tap',      // how the start was set
  'arrive', 'inside',                                            // got all the way there
  'ask_answered', 'ask_escalated', 'report',                     // the other features
  'drive_handoff', 'drive_fallback',                             // opened a maps app; our driving line was unavailable
];

/** Daily counts of every site kind for the last `days` days (Los Angeles dates), oldest first. */
export async function siteStats(db, sinceDay) {
  const raw = await db.prepare("SELECT COALESCE(json_group_array(json_object('day',day,'kind',kind,'n',count)),'[]') AS data FROM usage_counts WHERE link=? AND day>=?")
    .bind(SITE, sinceDay).first('data');
  const byDay = {};
  for (const r of JSON.parse(raw || '[]')) {
    if (!SITE_KINDS.includes(r.kind)) continue;
    (byDay[r.day] ??= Object.fromEntries(SITE_KINDS.map(k => [k, 0])))[r.kind] = r.n;
  }
  const days = Object.keys(byDay).sort().map(day => ({day, ...byDay[day]}));
  const totals = Object.fromEntries(SITE_KINDS.map(k => [k, days.reduce((s, d) => s + d[k], 0)]));
  return {days, totals};
}
