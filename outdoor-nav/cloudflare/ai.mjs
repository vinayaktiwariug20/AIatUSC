// The one AI service Doorstep talks to: a small Replit app (see AI_SERVICE.md)
// that calls a model through Replit AI Integrations. Endpoints: /triage, /ask.
//
// Everything here is best-effort. A missing, slow or broken service returns
// null and the caller carries on without AI -- the app must work without it.

export const aiConfigured = env => Boolean(env.AI_URL && env.AI_SECRET);

/** POST JSON to the AI service. Returns the parsed reply, or null on any failure. */
export async function callAi(env, path, body, timeoutMs = 10_000) {
  if (!aiConfigured(env)) return null;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(String(env.AI_URL).replace(/\/+$/, '') + path, {
      method: 'POST', signal: controller.signal,
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + env.AI_SECRET},
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
