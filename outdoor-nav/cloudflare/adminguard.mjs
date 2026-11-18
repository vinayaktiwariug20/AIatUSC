// Slows down guessing the admin token. The code is public, so the token's strength
// is the only protection: after too many *different* wrong tokens from one address
// in 15 minutes, admin requests from there are refused until the window ends.
// Repeating the same typo counts once, so a staff member who mistyped isn't locked
// out by the page resending it. The address is stored only as a salted hash, for
// up to 30 minutes, in the existing routing_usage table (expired rows are swept).

export const ADMIN_GUARD = {window_ms: 15 * 60000, max_wrong: 10};

async function hash(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** null = carry on; otherwise the message for a 429. Never throws.
 * isKnown(supplied): true for a valid staff key, which is never counted as a guess. */
export async function adminGuard(request, env, db, now = Date.now(), isKnown = null) {
  const token = String(env.ADMIN_TOKEN || ''), supplied = (request.headers.get('X-Admin-Token') || '').trim();
  if (!db || !token || !supplied) return null;
  try {
    const {window_ms, max_wrong} = ADMIN_GUARD, w = Math.floor(now / window_ms), expires = now + window_ms * 2;
    const who = await hash(token + '|' + (request.headers.get('CF-Connecting-IP') || 'unknown'));
    const counter = 'adminfail:' + who + ':' + w;
    const wrong = await db.prepare('SELECT count FROM routing_usage WHERE slot=?').bind(counter).first('count') || 0;
    if (wrong >= max_wrong) return 'Too many wrong admin tokens from this connection. Try again in 15 minutes.';
    if (supplied === token) return null;
    if (isKnown && await isKnown(supplied)) return null;
    const guess = 'adminguess:' + who + ':' + await hash(token + '|' + supplied) + ':' + w;
    const fresh = await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO NOTHING RETURNING count')
      .bind(guess, expires).first('count');
    if (fresh) await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET count=count+1')
      .bind(counter, expires).run();
    return null;
  } catch {
    return null;          // no usage table yet: never block staff because of the guard
  }
}
