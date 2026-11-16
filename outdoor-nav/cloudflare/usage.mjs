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
