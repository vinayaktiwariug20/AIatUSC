import {Unreachable} from './router.mjs';

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});
function parts(ms) {
  return Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
}
function utcParts(p) { return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); }
export function campusISO(ms) {
  const p = parts(ms), minutes = Math.round((utcParts(p) - Math.floor(ms / 1000) * 1000) / 60000);
  const offset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}
export function parseTime(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 64) fail(400, 'Invalid date/time.');
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    const result = Date.parse(value); if (!Number.isFinite(result)) fail(400, 'Invalid date/time.');
    return result;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) fail(400, 'Use an ISO date/time. Times without offsets use Los Angeles time.');
  const [, y, month, day, hour, minute, second = '00'] = m;
  const desired = Date.UTC(+y, +month - 1, +day, +hour, +minute, +second);
  const d = new Date(desired);
  if (d.getUTCFullYear() !== +y || d.getUTCMonth() + 1 !== +month || d.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59) fail(400, 'Invalid date/time.');
  let result = desired;
  for (let n = 0; n < 4; n++) {
    const delta = desired - utcParts(parts(result)); if (!delta) return result;
    result += delta;
  }
  if (utcParts(parts(result)) !== desired) fail(400, 'This local time does not exist during the daylight-saving transition.');
  return result;
}
function ll(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(400, 'Valid numeric lat/lon coordinates are required.');
  return [lat, lon];
}
function isAdmin(headers, env) {
  const token = String(env.ADMIN_TOKEN || ''), supplied = headers.get('X-Admin-Token') || '';
  return token.length > 0 && supplied === token;
}
export function gateStatus(data, when) {
  const p = parts(when), date = `${p.year}-${p.month}-${p.day}`;
  const column = (data.holidays || []).includes(date) ? 'holiday' : ['Sat', 'Sun'].includes(p.weekday) ? 'weekend' : 'weekday';
  const minute = +p.hour * 60 + +p.minute;
  const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return (data.gates || []).map(g => {
    let vehicle = {status: 'closed', column};
    for (const span of g[column] || []) {
      const a = mins(span.from), b = mins(span.to);
      if (a < b ? a <= minute && minute < b : minute >= a || minute < b) {
        vehicle = {status: span.access || 'open', until: span.to, column}; break;
      }
    }
    return {id: g.id, name: g.name, where: g.where ?? null, place: g.place ?? null, note: g.note ?? null,
      vehicle, pedestrian: g.pedestrian || {status: 'not_stated'}};
  });
}
async function active(db, when) {
  if (!db) return [];
  const raw = await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM closures WHERE starts_ms<=? AND ends_ms>? AND status!='rejected' ORDER BY created_ms,id LIMIT 101)").bind(when, when).first('data');
  const rows = JSON.parse(raw);
  if (rows.length > 100) fail(503, 'Too many active reports. Staff must review and reduce them.');
  return rows;
}
function reply(data, status = 200, head = false, extra = {}) {
  return new Response(head ? null : JSON.stringify(data), {status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra}});
}

export async function handleApi(request, env, {router, gateData}) {
  const url = new URL(request.url), method = request.method === 'HEAD' ? 'GET' : request.method;
  const head = request.method === 'HEAD';
  if (method === 'OPTIONS') return new Response(null, {status: 204, headers: {Allow: 'GET, HEAD, POST, DELETE, OPTIONS'}});
  if (!['GET', 'POST', 'DELETE'].includes(method)) return reply({error: 'method not allowed'}, 405, head, {Allow: 'GET, HEAD, POST, DELETE, OPTIONS'});
  let body = {};
  try {
    if (method === 'POST' || method === 'DELETE') {
      if (Number(request.headers.get('Content-Length') || 0) > 16384) fail(413, 'Request too large.');
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 16384) fail(413, 'Request too large.');
      try { body = text ? JSON.parse(text) : {}; } catch { fail(400, 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON body must be an object.');
    }
    const path = url.pathname, db = env.DB, data = router.data;
    if (method === 'GET' && path === '/api/health') {
      if (db && await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='closures'").first('name') !== 'closures') return reply({ok: false, database: 'migration_required'}, 503, head);
      return reply({ok: true, app: 'AIatUSC', runtime: 'cloudflare-javascript',
        database: db ? 'connected' : 'not_configured', storage: db ? 'd1' : 'read_only_preview',
        timezone: 'America/Los_Angeles', walking_routes: true, driving_routes: false, turn_by_turn: false,
        public_reports: Boolean(db) && env.PUBLIC_REPORTS_ENABLED === 'true'}, 200, head);
    }
    if (method === 'GET' && path === '/api/buildings') {
      const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 200);
      const rows = Object.values(data.buildings).filter(b => !q || b.name.toLowerCase().includes(q) || (b.aliases || []).some(a => a.toLowerCase().includes(q)))
        .map(b => ({id: b.id, name: b.name, lat: b.lat, lon: b.lon, entrance_source: b.entrance_source ?? null, entrances: (b.entrances || []).length}))
        .sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
      return reply(rows, 200, head);
    }
    if (method === 'GET' && path === '/api/places') return reply(Object.values(data.places).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(p => ({id:p.id,name:p.name,kind:p.kind})), 200, head);
    if (method === 'GET' && path === '/api/gates') return reply({source: gateData.source || '', scope: 'vehicle hours; pedestrian access is not stated by the source', timezone: 'America/Los_Angeles', gates: gateStatus(gateData, parseTime(url.searchParams.get('at')))}, 200, head);
    const building = /^\/api\/buildings\/([^/]+)$/.exec(path);
    if (method === 'GET' && building) return Object.hasOwn(data.buildings,building[1]) ? reply(data.buildings[building[1]], 200, head) : reply({error:'no such building'},404,head);
    if (method === 'GET' && path === '/api/closures') return reply(await active(db, parseTime(url.searchParams.get('at'))),200,head);
    if (method === 'POST' && path === '/api/outdoor/route') {
      if ((body.mode || 'walking') !== 'walking') fail(501, 'Vehicle routing is not implemented in this repository yet.');
      const from = body.from;
      if (!from || typeof from !== 'object' || Array.isArray(from) || typeof body.to !== 'string' || body.to.length > 200) fail(400,'Need from:{lat,lon} or from:{place}, and to.');
      const place = from.place || null;
      if (place !== null && typeof place !== 'string') fail(400,'Invalid start place.');
      const [lat, lon] = place ? [null, null] : ll(from.lat, from.lon);
      if (!place && !router.containsStart(lat,lon)) return reply({ok:false,reason:'Start is outside the campus walking map. Choose a campus gate or parking exit.',blocked_by:[]});
      const when = parseTime(body.at), rows = await active(db,when);
      try {
        const out = router.route({lat,lon,place,building:body.to,stepFree:Boolean(body.step_free),
          closures: rows.filter(c => c.status === 'approved'), reports: rows.filter(c => c.status === 'unverified')});
        if (out.summary.start_place) out.summary.vehicle_access = gateStatus(gateData,when).filter(g => g.place === out.summary.start_place.id);
        out.summary.storage = db ? 'd1' : 'read_only_preview';
        return reply({ok:true,...out});
      } catch (error) {
        if (error instanceof Unreachable) return reply({ok:false,reason:error.message,blocked_by:error.blockedBy,choices:error.choices});
        throw error;
      }
    }
    if (method === 'POST' && path === '/api/closures') {
      if (!db) fail(503,'Connect D1 and apply the migration before posting reports.');
      const official = isAdmin(request.headers,env);
      if (!official && env.PUBLIC_REPORTS_ENABLED !== 'true') fail(403,'Public reports are not enabled. Staff can use an admin token.');
      const [lat,lon] = ll(body.lat,body.lon), radius = body.radius_m ?? 15;
      if (!router.containsStart(lat,lon) || typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > 200) fail(400,'Invalid campus location or radius.');
      const now = Date.now(), starts = parseTime(body.starts,now), ends = parseTime(body.ends,starts + 4 * 3600000);
      if (ends <= starts || ends - starts > 7 * 86400000) fail(400,'Closure end must follow start, within seven days.');
      const c = {id: crypto.randomUUID().replaceAll('-','').slice(0,16),kind:String(body.kind || 'blockage').slice(0,50),
        lat,lon,radius_m:radius,note:String(body.note || '').slice(0,280),source:official?'official':'public',status:official?'approved':'unverified',
        starts:campusISO(starts),ends:campusISO(ends),created:campusISO(now)};
      await db.prepare('INSERT INTO closures(id,status,starts_ms,ends_ms,created_ms,payload) VALUES(?,?,?,?,?,?)')
        .bind(c.id,c.status,starts,ends,now,JSON.stringify(c)).run();
      return reply(c,201);
    }
    const closure = /^\/api\/closures\/([0-9a-f]+)(?:\/(approve|reject))?$/.exec(path);
    if (closure && ['POST','DELETE'].includes(method)) {
      if (!isAdmin(request.headers,env)) fail(403,'admin token required');
      if (!db) fail(503,'D1 is not connected.');
      const [,id,action] = closure;
      if (method === 'DELETE' && !action) {
        const deleted = await db.prepare('DELETE FROM closures WHERE id=? RETURNING id').bind(id).first('id');
        return deleted ? reply({deleted:id}) : reply({error:'not found'},404);
      }
      if (method === 'POST' && action) {
        const status = action === 'approve' ? 'approved' : 'rejected';
        const row = await db.prepare("UPDATE closures SET status=?,payload=json_set(payload,'$.status',?) WHERE id=? RETURNING payload").bind(status,status,id).first('payload');
        return row ? reply(JSON.parse(row)) : reply({error:'not found'},404);
      }
    }
    return reply({error:'not found'},404,head);
  } catch (error) {
    return reply({ok:false,error:error instanceof ApiError ? error.message : 'Closure storage or routing is unavailable. Please retry.'},error instanceof ApiError ? error.status : 503,head);
  }
}
