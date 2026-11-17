// Suggestions for the "From" box: campus places from our own data first (no
// outside service), then street addresses from openrouteservice's search. The
// API key stays on the server. Results are limited to the Los Angeles area and
// biased towards USC.

export const USC = {lat: 34.0205, lon: -118.2856};
const LA = {min_lon: -118.70, max_lon: -117.90, min_lat: 33.70, max_lat: 34.35};
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Buildings (by name or code) and parking structures (from their pedestrian exit). */
export function campusPlaces(context, q, limit = 5) {
  const t = norm(q);
  if (t.length < 2) return [];
  const out = [];
  for (const b of Object.values(context.router.data.buildings)) {
    const name = norm(b.name), aliases = (b.aliases || []).map(norm);
    const rank = aliases.includes(t) ? 0 : name.startsWith(t) ? 1
      : (name.includes(t) || aliases.some(a => a.startsWith(t))) ? 2 : -1;
    if (rank < 0 || !Number.isFinite(b.lat)) continue;
    const code = (b.aliases || []).find(a => /^[A-Z]{2,4}$/.test(a));
    out.push({rank, kind: 'building', id: b.id, label: b.name + (code ? ` (${code})` : ''), lat: b.lat, lon: b.lon});
  }
  for (const p of context.mobilityData.parking || []) {
    const name = norm(p.name);
    if (!name.includes(t) && !norm(p.id).startsWith(t)) continue;
    const exit = context.survey.nodes.find(n => n.id === p.exit);
    if (exit) out.push({rank: name.startsWith(t) ? 1 : 2, kind: 'parking', id: p.id, label: p.name, lat: exit.lat, lon: exit.lon});
  }
  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .slice(0, limit).map(({rank, ...r}) => r);
}

/** Street addresses near USC, or null if the search is unavailable. */
export async function addressSearch(env, q, fetcher = fetch) {
  if (!env.ORS_API_KEY) return null;
  const u = new URL('https://api.openrouteservice.org/geocode/autocomplete');
  u.searchParams.set('text', q);
  u.searchParams.set('size', '5');
  u.searchParams.set('focus.point.lat', String(USC.lat));
  u.searchParams.set('focus.point.lon', String(USC.lon));
  for (const [k, v] of Object.entries(LA)) u.searchParams.set('boundary.rect.' + k, String(v));
  u.searchParams.set('boundary.country', 'US');
  try {
    const r = await fetcher(u.toString(), {headers: {Authorization: env.ORS_API_KEY, Accept: 'application/json'}, signal: AbortSignal.timeout(6000)});
    if (!r.ok) return null;
    const d = await r.json();
    return (d.features || [])
      .filter(f => f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates))
      .map(f => ({kind: 'address', label: String(f.properties?.label || f.properties?.name || '').slice(0, 120),
        lat: Number(f.geometry.coordinates[1]), lon: Number(f.geometry.coordinates[0])}))
      .filter(x => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lon)
        && x.lat >= LA.min_lat && x.lat <= LA.max_lat && x.lon >= LA.min_lon && x.lon <= LA.max_lon)
      .slice(0, 5);
  } catch {
    return null;
  }
}

/** Address search is a shared, limited resource: 30 a minute and 900 a day overall (under the free plan's geocoding allowance). */
export async function reserveGeocodeQuota(db, now = Date.now()) {
  try {
    for (const [prefix, size, limit] of [['day', 86400000, 900], ['minute', 60000, 30]]) {
      const slot = 'geocode:' + prefix + ':' + Math.floor(now / size);
      const n = await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET count=count+1 WHERE count<? RETURNING count')
        .bind(slot, now + size * 2, limit).first('count');
      if (!n) return false;
    }
    return true;
  } catch {
    return true;     // no usage table yet: don't block search
  }
}
