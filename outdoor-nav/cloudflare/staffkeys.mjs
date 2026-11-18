// Staff keys: one per person or desk, each revocable on its own, with fewer powers
// than the team's admin token. A generated key is five everyday words from the EFF
// list ("acorn tidal maple shrug otter", about 51 bits; the wrong-token lockout makes
// guessing hopeless). The admin can also roll words and pick their own. Case, spaces
// and hyphens don't matter. Only a SHA-256 hash is stored.
import {WORDS} from './words.mjs';

const LIMIT = Math.floor(65536 / WORDS.length) * WORDS.length;
function randomWord() {
  const b = new Uint16Array(1);
  for (;;) { crypto.getRandomValues(b); if (b[0] < LIMIT) return WORDS[b[0] % WORDS.length]; }   // no modulo bias
}
export const makeKey = (words = 5) => Array.from({length: words}, randomWord).join(' ');
/** Fresh words to pick from; distinct within one roll. */
export function rollWords(n = 10) {
  const out = new Set(); while (out.size < Math.min(Math.max(n, 1), 30)) out.add(randomWord());
  return [...out];
}
const tidy = k => String(k || '').toLowerCase().trim().split(/[\s-]+/).filter(Boolean).join(' ');
const BANNED = ['doorstep', 'trojan', 'usc', 'password', 'admin', 'fighton', 'qwerty', '1234'];
/** null if a key someone chose is acceptable, otherwise why not. */
export function checkOwnKey(key, adminToken = '') {
  const words = tidy(key).split(' ').filter(Boolean), flat = words.join('');
  if (flat.length < 16 || (words.length < 4 && flat.length < 20)) return 'Use at least 4 words (or 20 letters), 16 letters in all.';
  if (new Set(words).size < words.length) return 'Use each word only once.';
  if (BANNED.some(b => flat.includes(b))) return 'Avoid guessable words like doorstep, trojan, usc or password.';
  if (adminToken && normalizeKey(adminToken) === flat) return "That's the admin token. Pick something else.";
  return null;
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
export async function createStaffKey(db, name, own = '', adminToken = '', now = Date.now()) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return {error: 'Give the key a name, such as "Transportation dispatch".'};
  if (String(own || '').length > 200) return {error: 'That key is too long.'};
  const chosen = tidy(own);
  if (chosen) { const why = checkOwnKey(chosen, adminToken); if (why) return {error: why}; }
  const key = chosen || makeKey(), hash = await hashKey(key), id = crypto.randomUUID().replaceAll('-', '');
  if (await db.prepare('SELECT id FROM staff_keys WHERE key_hash=?').bind(hash).first('id')) return {error: 'That key is (or was) already in use. Pick another.'};
  await db.prepare('INSERT INTO staff_keys(id,name,key_hash,created_ms) VALUES(?,?,?,?)').bind(id, clean, hash, now).run();
  return {id, name: clean, key, created_ms: now};
}
export async function listStaffKeys(db) {
  const value = await db.prepare("SELECT COALESCE(json_group_array(json_object('id',id,'name',name,'created_ms',created_ms,'last_used_ms',last_used_ms,'revoked_ms',revoked_ms)),'[]') AS data FROM (SELECT * FROM staff_keys ORDER BY created_ms DESC LIMIT 100)").first('data');
  return JSON.parse(value);
}
/** Removes a key from the list; only one already revoked, so a working key can't vanish by mistake. */
export async function removeStaffKey(db, id) {
  return await db.prepare('DELETE FROM staff_keys WHERE id=? AND revoked_ms IS NOT NULL RETURNING id').bind(id).first('id');
}
export async function revokeStaffKey(db, id, now = Date.now()) {
  return await db.prepare('UPDATE staff_keys SET revoked_ms=? WHERE id=? AND revoked_ms IS NULL RETURNING id').bind(now, id).first('id');
}
