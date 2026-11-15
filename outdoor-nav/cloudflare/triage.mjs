// AI triage of public blockage reports.
//
// The model only SUGGESTS. Nothing in this file changes a route or a report's
// status: a suggestion is stored next to the report, shown to staff, and only
// a staff approval (optionally "as suggested") makes it a closure.
//
// The model runs in a separate service (deployed on Replit, using Replit AI
// Integrations), called with a shared secret. Contract: see TRIAGE.md.
// If that service is not configured, slow, down or returns nonsense, reporting
// still works -- the report just has no suggestion.

export const CATEGORIES = ['construction', 'event_setup', 'crowd', 'spill_or_flooding',
  'vehicle_blocking', 'other_blockage', 'not_a_blockage', 'unclear'];
export const PHOTO_MAX_CHARS = 400_000;      // a ~300 KB JPEG as a data URL
const TIMEOUT_MS = 10_000;

/** null when absent; a string error message when unusable; otherwise the data URL. */
export function checkPhoto(photo) {
  if (photo === undefined || photo === null || photo === '') return null;
  if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(photo))
    return {error: 'Photo must be a JPEG, PNG or WebP data URL.'};
  if (photo.length > PHOTO_MAX_CHARS) return {error: 'Photo is too large. Please retake it.'};
  return {photo};
}

export const configured = env => Boolean(env.TRIAGE_URL && env.TRIAGE_SECRET);

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

/** Whitelist and clamp whatever the model service returned. */
export function clean(raw, nearbyIds = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {status: 'invalid'};
  return {
    status: 'ok',
    category: CATEGORIES.includes(raw.category) ? raw.category : 'unclear',
    blocks_walking: raw.blocks_walking === true,
    summary: String(raw.summary ?? '').slice(0, 120),
    confidence: num(raw.confidence, 0, 1),
    suggested_radius_m: Math.round(num(raw.suggested_radius_m, 5, 60) ?? 15),
    suggested_hours: num(raw.suggested_hours, 0.5, 72),
    duplicate_of: nearbyIds.includes(raw.duplicate_of) ? raw.duplicate_of : null,
    reason: String(raw.reason ?? '').slice(0, 200),
  };
}

/** Ask the triage service. Returns null if not configured, else an `ai` object. */
export async function triage(env, input) {
  if (!configured(env)) return null;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(String(env.TRIAGE_URL).replace(/\/+$/, '') + '/triage', {
      method: 'POST', signal: controller.signal,
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TRIAGE_SECRET},
      body: JSON.stringify(input),
    });
    if (!r.ok) return {status: 'unavailable'};
    return clean(await r.json(), (input.nearby || []).map(n => n.id));
  } catch {
    return {status: 'unavailable'};
  } finally {
    clearTimeout(timer);
  }
}
