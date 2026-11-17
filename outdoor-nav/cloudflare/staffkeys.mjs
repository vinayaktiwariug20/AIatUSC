// Staff keys: one per person or desk, each revocable on its own, with fewer powers
// than the team's admin token. A key is made-up words, easy to read aloud and type
// on a phone ("tamoru kebisa lodupe vineko", about 76 bits). Case, spaces and
// hyphens don't matter. Only a SHA-256 hash is stored.

const CONSONANTS = 'bdfghjklmnprstvz', VOWELS = 'aeiou';
const SYLLABLES = [...CONSONANTS].flatMap(c => [...VOWELS].map(v => c + v));   // 80

function randomSyllable() {
  const b = new Uint8Array(1);
  for (;;) { crypto.getRandomValues(b); if (b[0] < 240) return SYLLABLES[b[0] % 80]; }   // no modulo bias
}
export function makeKey(words = 4, syllables = 3) {
  return Array.from({length: words}, () => Array.from({length: syllables}, randomSyllable).join('')).join(' ');
}
export const normalizeKey = k => String(k || '').toLowerCase().replace(/[\s-]+/g, '');
export async function hashKey(k) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('doorstep-staff:' + normalizeKey(k)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The staff member this key belongs to, or null. Never throws (no table yet = no staff). */
export async function findStaff(db, supplied, now = Date.now()) {
  if (!db || normalizeKey(supplied).length < 20) return null;
  try {
    const row = await db.prepare('SELECT id, name, last_used_ms FROM staff_keys WHERE key_hash=? AND revoked_ms IS NULL').bind(await hashKey(supplied)).first();
    if (!row) return null;
    if (!row.last_used_ms || now - row.last_used_ms > 3600000)      // at most one write an hour
      await db.prepare('UPDATE staff_keys SET last_used_ms=? WHERE id=?').bind(now, row.id).run();
    return {id: row.id, name: row.name};
  } catch {
    return null;
  }
}
export async function createStaffKey(db, name, now = Date.now()) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return {error: 'Give the key a name, such as "Transportation dispatch".'};
  const key = makeKey(), id = crypto.randomUUID().replaceAll('-', '');
  await db.prepare('INSERT INTO staff_keys(id,name,key_hash,created_ms) VALUES(?,?,?,?)').bind(id, clean, await hashKey(key), now).run();
  return {id, name: clean, key, created_ms: now};
}
export async function listStaffKeys(db) {
  const value = await db.prepare("SELECT COALESCE(json_group_array(json_object('id',id,'name',name,'created_ms',created_ms,'last_used_ms',last_used_ms,'revoked_ms',revoked_ms)),'[]') AS data FROM (SELECT * FROM staff_keys ORDER BY created_ms DESC LIMIT 100)").first('data');
  return JSON.parse(value);
}
export async function revokeStaffKey(db, id, now = Date.now()) {
  return await db.prepare('UPDATE staff_keys SET revoked_ms=? WHERE id=? AND revoked_ms IS NULL RETURNING id').bind(now, id).first('id');
}
