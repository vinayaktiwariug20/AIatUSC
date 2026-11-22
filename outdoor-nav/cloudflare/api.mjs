import {Unreachable, haversine} from './router.mjs';
import {triage, checkPhoto, configured as triageConfigured} from './triage.mjs';
import {USAGE_KINDS, linkKey, usageReady, countUsage, usageTotals, reserveUsageQuota, SITE, SITE_KINDS, siteStats} from './usage.mjs';
import {campusPlaces, addressSearch, reserveGeocodeQuota, hasHouseNumber, censusSearch, GEOCODE_LIMITS} from './geocode.mjs';
import {collectFacts, cleanAnswer, askModel, recentAnswers, storeQuestion, getQuestion, setAnswer, dismiss, staffList, reserveAskQuota, QUESTION_MAX, ANSWER_MAX} from './assistant.mjs';
const questionsReady=async db=>await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='questions'").first('name')==='questions';
import {adminGuard} from './adminguard.mjs';
import {findStaff, createStaffKey, listStaffKeys, revokeStaffKey, removeStaffKey, rollWords} from './staffkeys.mjs';
import {MobilityError, readRules, mobilityState, gateState, validateRule, validateParkingStatus, validateParkingRate, drivingRoute, forMode, reserveReportQuota, walkingRuleClosures, orsUsage, softGates} from './mobility.mjs';

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
// On foot, from Transportation's gate schedule where we have it. DPS opens and closes
// some gates within an hour, so that hour is 'varies' rather than open or closed.
function pedestrianStatus(g, column, minute, source) {
  const h = g.pedestrian_hours; if (!h) return null;
  if (!Array.isArray(h[column])) return {status: 'not_stated', column};
  const mins = t => { const [hh, mm] = t.split(':').map(Number); return hh * 60 + mm; };
  const inside = s => { const a = mins(s.from), b = mins(s.to); return a < b ? a <= minute && minute < b : minute >= a || minute < b; };
  const base = {column, source: h.source || source || 'USC Transportation gate schedule'};
  const open = h[column].find(inside); if (open) return {...base, status: 'open', until: open.to};
  const edge = (h.uncertain?.[column] || []).find(inside); if (edge) return {...base, status: 'varies', note: edge.note || null, until: edge.to};
  return {...base, status: 'closed'};
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
      vehicle, pedestrian: pedestrianStatus(g, column, minute, data.pedestrian_source) || g.pedestrian || {status: 'not_stated'}};
  });
}
async function active(db, when, until = when + 1) {
  if (!db) return [];
  const raw = await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM closures WHERE starts_ms<? AND ends_ms>? AND status!='rejected' ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END,created_ms DESC,id LIMIT 121)").bind(until, when).first('data');
  const rows = JSON.parse(raw);
  const approved=rows.filter(c=>c.status==='approved');
  if (approved.length > 100) fail(503, 'Too many approved closures. Staff must review and reduce them.');
  return [...approved,...rows.filter(c=>c.status==='unverified').slice(0,20)];
}
function reply(data, status = 200, head = false, extra = {}) {
  return new Response(head ? null : JSON.stringify(data), {status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra}});
}

export async function handleApi(request, env, context) {
  const {router,gateData}=context;
  context={...context,time:{parseTime,campusISO,gateStatus}};
  const url = new URL(request.url), method = request.method === 'HEAD' ? 'GET' : request.method;
  const head = request.method === 'HEAD';
  if (method === 'OPTIONS') return new Response(null, {status: 204, headers: {Allow: 'GET, HEAD, POST, DELETE, OPTIONS'}});
  if (!['GET', 'POST', 'DELETE'].includes(method)) return reply({error: 'method not allowed'}, 405, head, {Allow: 'GET, HEAD, POST, DELETE, OPTIONS'});
  let body = {};
  try {
    if (method === 'POST' || method === 'DELETE') {
      // Reports may carry one compressed photo for AI triage; everything else stays small.
      const limit = method === 'POST' && url.pathname === '/api/closures' ? 450000 : 16384;
      if (Number(request.headers.get('Content-Length') || 0) > limit) fail(413, 'Request too large.');
      const text = await request.text();
      if (new TextEncoder().encode(text).length > limit) fail(413, 'Request too large.');
      try { body = text ? JSON.parse(text) : {}; } catch { fail(400, 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON body must be an object.');
    }
    const path = url.pathname, db = env.DB, data = router.data;
    // Wrong-token lockout applies to staff actions only; routes and search keep working.
    let staff = null, staffChecked = false;
    const isStaffKey = async supplied => { staffChecked = true; staff = await findStaff(db, supplied); return staff !== null; };
    const locked = await adminGuard(request, env, db, Date.now(), isStaffKey);
    const admin = !locked && isAdmin(request.headers, env);
    if (!locked && !admin && !staffChecked && request.headers.get('X-Admin-Token')) await isStaffKey(request.headers.get('X-Admin-Token'));
    if (locked) staff = null;
    // Team admin: everything. Staff key: closures, parking statuses and report review only.
    const requireAdmin = () => { if (locked) fail(429, locked); if (!admin) fail(403, 'admin token required'); };
    const requireStaff = () => { if (locked) fail(429, locked); if (!admin && !staff) fail(403, 'staff key or admin token required'); };
    const actor = () => admin ? 'Team admin' : staff?.name;
    if (method === 'GET' && path === '/api/health') {
      if (db && await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='closures'").first('name') !== 'closures') return reply({ok: false, database: 'migration_required'}, 503, head);
      const mobilityReady=!db||await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mobility_rules'").first('name')==='mobility_rules';
      return reply({ok: true, app: 'AIatUSC', runtime: 'cloudflare-javascript',
        database: db ? 'connected' : 'not_configured', storage: db ? 'd1' : 'read_only_preview',
        timezone: 'America/Los_Angeles', walking_routes: true, driving_routes: Boolean(db && env.ORS_API_KEY && mobilityReady), turn_by_turn: false,
        parking_handoff:true,mobility_migration:mobilityReady?'ready':'required',ai_service:triageConfigured(env),questions_migration:!db||await questionsReady(db)?'ready':'required',usage_migration:!db||await usageReady(db)?'ready':'required',parking_status_migration:!db||await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='parking_status'").first('name')==='parking_status'?'ready':'required',driving_provider:'openrouteservice',live_traffic:false,unverified_report_display_limit:20,
        public_reports: Boolean(db) && env.PUBLIC_REPORTS_ENABLED === 'true'}, 200, head);
    }
    if (method === 'GET' && path === '/api/buildings') {
      const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 200);
      const rows = Object.values(data.buildings).filter(b => !q || b.name.toLowerCase().includes(q) || (b.aliases || []).some(a => a.toLowerCase().includes(q)))
        .map(b => ({id: b.id, name: b.name, aliases: b.aliases || [], lat: b.lat, lon: b.lon, entrance_source: b.entrance_source ?? null, entrances: (b.entrances || []).length, hours_url: b.hours_url ?? null}))
        .sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
      return reply(rows, 200, head);
    }
    if (method === 'GET' && path === '/api/places') return reply(Object.values(data.places).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(p => ({id:p.id,name:p.name,kind:p.kind})), 200, head);
    if (method === 'GET' && ['/api/gates','/api/mobility'].includes(path)) {
      const when=parseTime(url.searchParams.get('at')),rules=await readRules(db,when),credentials={usc_id:url.searchParams.get('usc_id')==='true',parking_pass:url.searchParams.get('parking_pass')==='true',permit:url.searchParams.get('permit')||null};
      if(path==='/api/mobility')return reply(mobilityState(context,when,rules,credentials),200,head);
      return reply({source:gateData.source||'',scope:'vehicle hours from the public page; pedestrian hours from the Transportation gate schedule where known',timezone:'America/Los_Angeles',gates:gateState(context,when,rules,credentials)},200,head);
    }
    if (path === '/api/whoami' && method === 'GET') {
      if (locked) fail(429, locked);
      return reply({role: admin ? 'admin' : staff ? 'staff' : null, name: actor() || null}, 200, head);
    }
    if (path === '/api/staff-keys') {
      requireAdmin(); if (!db) fail(503, 'D1 is not connected.');
      try {
        if (method === 'GET') return reply(await listStaffKeys(db), 200, head);
        if (method === 'POST') { const made = await createStaffKey(db, body.name, body.key, env.ADMIN_TOKEN); return made.error ? reply({error: made.error}, 400) : reply(made, 201); }
      } catch { fail(503, 'Staff keys need database migration 0006. It is applied on the next deploy, or run npm run db:remote.'); }
    }
    if (path === '/api/staff-keys/roll' && method === 'GET') {
      requireAdmin();
      return reply({words: rollWords(parseInt(url.searchParams.get('n') || '10', 10) || 10)}, 200, head);
    }
    const staffKey = /^\/api\/staff-keys\/([0-9a-f]+)$/.exec(path);
    if (staffKey && method === 'DELETE') {
      requireAdmin(); if (!db) fail(503, 'D1 is not connected.');
      if (url.searchParams.get('remove') === '1') {
        let removed = null; try { removed = await removeStaffKey(db, staffKey[1]); } catch {}
        return removed ? reply({removed}) : reply({error: 'Only a revoked key can be removed.'}, 404);
      }
      let revoked = null; try { revoked = await revokeStaffKey(db, staffKey[1]); } catch {}
      return revoked ? reply({revoked}) : reply({error: 'not found'}, 404);
    }
    if (path === '/api/mobility/rules' && method === 'GET') {
      requireStaff();
      const when=parseTime(url.searchParams.get('at'));
      return reply(await readRules(db,when,when+7*86400000),200,head);
    }
    if (path === '/api/mobility/rules' && method === 'POST') {
      requireStaff();
      if(!db)fail(503,'Connect D1 before posting gate or road closures.');
      if(body.kind==='parking'){
        const status={...validateParkingStatus(body,context),by:actor()};
        try{await db.prepare('INSERT INTO parking_status(id,parking,starts_ms,ends_ms,created_ms,payload) VALUES(?,?,?,?,?,?)').bind(status.id,status.parking,status.starts_ms,status.ends_ms,status.created_ms,JSON.stringify(status)).run();}
        catch{fail(503,'Parking status needs database migration 0005. It is applied on the next deploy, or run npm run db:remote.');}
        return reply(status,201);
      }
      if(body.kind==='rate'){
        const rate={...validateParkingRate(body,context),by:actor()};
        try{await db.prepare('INSERT INTO parking_rates(id,parking,starts_ms,ends_ms,created_ms,payload) VALUES(?,?,?,?,?,?)').bind(rate.id,rate.parking,rate.starts_ms,rate.ends_ms,rate.created_ms,JSON.stringify(rate)).run();}
        catch{fail(503,'Parking rates need database migration 0007. It is applied on the next deploy, or run npm run db:remote.');}
        return reply(rate,201);
      }
      const rule={...validateRule(body,context),by:actor()};
      await db.prepare('INSERT INTO mobility_rules(id,kind,starts_ms,ends_ms,created_ms,payload) VALUES(?,?,?,?,?,?)').bind(rule.id,rule.kind,rule.starts_ms,rule.ends_ms,rule.created_ms,JSON.stringify(rule)).run();
      return reply(rule,201);
    }
    const mobilityRule=/^\/api\/mobility\/rules\/([0-9a-f]+)$/.exec(path);
    if(mobilityRule&&method==='DELETE') {
      requireStaff();if(!db)fail(503,'D1 is not connected.');
      let deleted=await db.prepare('DELETE FROM mobility_rules WHERE id=? RETURNING id').bind(mobilityRule[1]).first('id');
      if(!deleted)try{deleted=await db.prepare('DELETE FROM parking_status WHERE id=? RETURNING id').bind(mobilityRule[1]).first('id');}catch{}
      if(!deleted)try{deleted=await db.prepare('DELETE FROM parking_rates WHERE id=? RETURNING id').bind(mobilityRule[1]).first('id');}catch{}
      return deleted?reply({deleted}):reply({error:'not found'},404);
    }
    const building = /^\/api\/buildings\/([^/]+)$/.exec(path);
    if (method === 'GET' && building) return Object.hasOwn(data.buildings,building[1]) ? reply(data.buildings[building[1]], 200, head) : reply({error:'no such building'},404,head);
    if (method === 'GET' && path === '/api/closures') return reply(await active(db, parseTime(url.searchParams.get('at'))),200,head);
    if (method === 'POST' && path === '/api/outdoor/route') {
      const mode=body.mode||'walking';
      if(!['walking','driving'].includes(mode))fail(400,'Mode must be walking or driving.');
      const from = body.from;
      if (!from || typeof from !== 'object' || Array.isArray(from) || typeof body.to !== 'string' || body.to.length > 200) fail(400,'Need from:{lat,lon} or from:{place}, and to.');
      const place = from.place || null;
      if (place !== null && typeof place !== 'string') fail(400,'Invalid start place.');
      const [lat, lon] = place ? [null, null] : ll(from.lat, from.lon);
      const when = parseTime(body.at);
      if(mode==='driving') {
        const rules=await readRules(db,when,when+6*3600000),rows=await active(db,when,when+6*3600000);
        try{return reply(await drivingRoute(context,body,when,rules,rows,env));}
        catch(error){if(error instanceof Unreachable)return reply({ok:false,reason:error.message,blocked_by:error.blockedBy,choices:error.choices});throw error;}
      }
      if (!place && !router.containsStart(lat,lon)) return reply({ok:false,reason:'Start is outside the campus walking map. Choose a campus gate or parking exit.',blocked_by:[]});
      const rows = forMode(await active(db,when),'walking'), rules = await readRules(db, when);
      // Staff rules closed on foot (areas, surveyed gates) apply to walking too.
      rows.push(...walkingRuleClosures(context, rules, when));
      if(from.exit!==undefined&&(typeof from.exit!=='string'||!place))fail(400,'A parking place is required for a surveyed exit.');
      try {
        const ask = extra => router.route({lat,lon,place,exit:from.exit??null,building:body.to,stepFree:Boolean(body.step_free),
          closures: [...rows.filter(c => c.status === 'approved'), ...extra], reports: rows.filter(c => c.status === 'unverified')});
        // Gates scheduled closed on foot: a preference, not a wall (see softGates).
        const soft = softGates(context, when, rules, ask([]), ask), out = soft.route;
        out.summary.gate_notes = soft.notes;
        if (out.summary.start_place) out.summary.vehicle_access = gateStatus(gateData,when).filter(g => g.place === out.summary.start_place.id);
        out.summary.storage = db ? 'd1' : 'read_only_preview';
        out.mode='walking';
        return reply({ok:true,...out});
      } catch (error) {
        if (error instanceof Unreachable) return reply({ok:false,reason:error.message,blocked_by:error.blockedBy,choices:error.choices});
        throw error;
      }
    }
    if (method === 'POST' && path === '/api/closures') {
      if (!db) fail(503,'Connect D1 and apply the migration before posting reports.');
      const official = admin || !!staff;
      if (!official && env.PUBLIC_REPORTS_ENABLED !== 'true') fail(403,'Public reports are not enabled. Staff can use an admin token.');
      const [lat,lon] = ll(body.lat,body.lon), radius = body.radius_m ?? 15;
      if (!router.containsStart(lat,lon) || typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > 200) fail(400,'Invalid campus location or radius.');
      const now = Date.now(), starts = parseTime(body.starts,now), ends = parseTime(body.ends,starts + 4 * 3600000);
      if (ends <= starts || ends - starts > 7 * 86400000) fail(400,'Closure end must follow start, within seven days.');
      const modes=body.modes??['walking'];
      if(!Array.isArray(modes)||!modes.length||modes.some(m=>!['walking','driving'].includes(m)))fail(400,'Choose walking and/or driving report modes.');
      if(!official){
        // The report counter lives in migration 0002. Say so plainly instead of "storage unavailable".
        try{await reserveReportQuota(db);}
        catch(e){if(/no such table/i.test(String(e?.message)))fail(503,'Reports are paused: the database needs an update (migration 0002). Staff: run npm run db:remote.');throw e;}
      }
      const c = {id: crypto.randomUUID().replaceAll('-','').slice(0,16),kind:String(body.kind || 'blockage').slice(0,50),modes:[...new Set(modes)],
        lat,lon,radius_m:radius,note:String(body.note || '').slice(0,280),source:official?'official':'public',status:official?'approved':'unverified',
        starts:campusISO(starts),ends:campusISO(ends),created:campusISO(now)};
      const photo = checkPhoto(body.photo);
      if (photo && photo.error) fail(400, photo.error);
      if (!official && (photo || c.note)) {
        // Up to 10 open reports within 60 m, so the model can spot a duplicate.
        const nearby = (await active(db, now)).filter(o => o.status === 'unverified' && haversine([lat, lon], [o.lat, o.lon]) <= 60)
          .slice(0, 10).map(o => ({id: o.id, note: o.note || '', category: o.ai?.category ?? null,
            distance_m: Math.round(haversine([lat, lon], [o.lat, o.lon]))}));
        const ai = await triage(env, {note: c.note, photo: photo ? photo.photo : null, lat, lon, reported_at: c.created, nearby});
        if (ai) c.ai = ai;           // a suggestion only; status stays 'unverified'
      }
      await db.prepare('INSERT INTO closures(id,status,starts_ms,ends_ms,created_ms,payload) VALUES(?,?,?,?,?,?)')
        .bind(c.id,c.status,starts,ends,now,JSON.stringify(c)).run();
      return reply(c,201);
    }
    const closure = /^\/api\/closures\/([0-9a-f]+)(?:\/(approve|reject))?$/.exec(path);
    if (closure && ['POST','DELETE'].includes(method)) {
      requireStaff();
      if (!db) fail(503,'D1 is not connected.');
      const [,id,action] = closure;
      if (method === 'DELETE' && !action) {
        const deleted = await db.prepare('DELETE FROM closures WHERE id=? RETURNING id').bind(id).first('id');
        return deleted ? reply({deleted:id}) : reply({error:'not found'},404);
      }
      if (method === 'POST' && action === 'approve' && body.apply_ai === true) {
        const row = await db.prepare('SELECT starts_ms,created_ms,payload FROM closures WHERE id=?').bind(id).first();
        if (!row) return reply({error:'not found'},404);
        const ai = JSON.parse(row.payload).ai;
        if (!ai || ai.status !== 'ok') fail(409, 'This report has no AI suggestion to apply.');
        const ends = Math.max(row.starts_ms + 1800000, row.created_ms + Math.round((ai.suggested_hours ?? 4) * 3600000));
        const out = await db.prepare("UPDATE closures SET status='approved',ends_ms=?,payload=json_set(payload,'$.status','approved','$.radius_m',?,'$.ends',?,'$.ai.applied',json('true')) WHERE id=? RETURNING payload")
          .bind(ends, ai.suggested_radius_m, campusISO(ends), id).first('payload');
        return reply(JSON.parse(out));
      }
      if (method === 'POST' && action) {
        const status = action === 'approve' ? 'approved' : 'rejected';
        const row = await db.prepare("UPDATE closures SET status=?,payload=json_set(payload,'$.status',?) WHERE id=? RETURNING payload").bind(status,status,id).first('payload');
        return row ? reply(JSON.parse(row)) : reply({error:'not found'},404);
      }
    }
    // ---- "From" box: campus places first, then street addresses ------------
    if (method === 'GET' && path === '/api/geocode') {
      const q = String(url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (q.length < 2) return reply({results: [], address: 'skipped'}, 200, head);
      const results = campusPlaces(context, q);
      let address = 'skipped';
      if (q.length >= 4) {
        if (!env.ORS_API_KEY) address = 'unavailable';
        else if (db && !(await reserveGeocodeQuota(db))) address = 'busy';
        else {
          let found = await addressSearch(env, q);
          // A house number openrouteservice doesn't know: ask the Census geocoder, and
          // put its exact matches before any whole-street guesses.
          if (hasHouseNumber(q) && !(found || []).some(r => r.kind === 'address')) {
            const census = await censusSearch(q);
            if (census?.length) found = [...census, ...(found || [])];
          }
          address = found ? 'ok' : 'unavailable';
          if (found) results.push(...found);
        }
      }
      return reply({results, address}, 200, head);
    }
    // ---- Site-wide counts for the team (see /privacy/) ---------------------
    if (path === '/api/stats') {
      const ready = db && await usageReady(db);
      if (method === 'POST') {
        if (!SITE_KINDS.includes(body.kind)) fail(400, 'Unknown stats kind.');
        if (ready && await reserveUsageQuota(db)) await countUsage(db, campusISO(Date.now()).slice(0, 10), SITE, body.kind);
        return new Response(null, {status: 204});
      }
      if (method === 'GET') {
        requireAdmin();
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);
        const openrouteservice = db ? await orsUsage(db, GEOCODE_LIMITS) : null;
        if (!ready) return reply({days, kinds: SITE_KINDS, stats: null, openrouteservice});
        return reply({days, kinds: SITE_KINDS, stats: await siteStats(db, campusISO(Date.now() - (days - 1) * 86400000).slice(0, 10)), openrouteservice});
      }
    }
    // ---- Anonymous usage counts (see /privacy/) ----------------------------
    if (path === '/api/usage') {
      const b = method === 'GET' ? Object.fromEntries(url.searchParams) : body;
      const building = router.findBuilding(String(b.to || ''));
      if (!building) fail(400, 'Unknown building.');
      const room = String(b.room || '').slice(0, 40), event = String(b.event || '').slice(0, 80);
      const key = await linkKey(building.id, room, event);
      if (!db || !(await usageReady(db))) return method === 'GET' ? reply({link: key, days: 30, totals: null}) : new Response(null, {status: 204});
      if (method === 'POST') {
        if (!USAGE_KINDS.includes(b.kind)) fail(400, 'Unknown usage kind.');
        if (await reserveUsageQuota(db)) await countUsage(db, campusISO(Date.now()).slice(0, 10), key, b.kind);
        return new Response(null, {status: 204});
      }
      if (method === 'GET') return reply({link: key, days: 30, totals: await usageTotals(db, key, campusISO(Date.now() - 30 * 86400000).slice(0, 10))}, 200, head);
    }
    // ---- Ask Doorstep ------------------------------------------------------
    if (method === 'POST' && path === '/api/ask') {
      const question = String(body.question ?? '').trim().replace(/\s+/g, ' ');
      if (!question || question.length > QUESTION_MAX) fail(400, 'Ask a question of up to ' + QUESTION_MAX + ' characters.');
      const now = Date.now();
      if (db && !(await questionsReady(db))) fail(503, 'Questions are paused: the database needs an update (migration 0003). Staff: run npm run db:remote.');
      if (db && !(await reserveAskQuota(db, now))) fail(429, 'Lots of questions right now. Please try again in a minute.');
      const [closures, answers, rules] = db ? await Promise.all([active(db, now), recentAnswers(db), readRules(db, now)]) : [[], [], []];
      const facts = collectFacts(context, now, {closures, answers, rules});
      const raw = await askModel(env, question, facts, campusISO(now));
      const out = cleanAnswer(raw, facts.map(f => f.id));
      const b = out.destination ? router.findBuilding(out.destination) : null, destination = b ? {id: b.id, name: b.name} : null;
      if (out.answered) return reply({ok: true, answered: true, answer: out.answer, destination,
        sources: out.citations.map(id => { const f = facts.find(x => x.id === id); return {id, source: f.source, text: f.text}; })});
      if (!db) return reply({ok: true, answered: false, message: "I couldn't answer that from verified information, and the Doorstep team's inbox isn't connected."});
      const q = await storeQuestion(db, question, now, campusISO, {ai_available: Boolean(raw)});
      return reply({ok: true, answered: false, question_id: q.id, destination,
        message: raw ? "I don't have verified information on that, so I've sent your question to the Doorstep team. Their answer will appear here."
                     : "The assistant is unavailable right now, so I've sent your question to the Doorstep team. Their answer will appear here."}, 201);
    }
    const qMatch = /^\/api\/questions\/([0-9a-f]{16})(?:\/(answer|dismiss))?$/.exec(path);
    if (method === 'GET' && qMatch && !qMatch[2]) {
      if (!db) fail(503, 'D1 is not connected.');
      const q = await getQuestion(db, qMatch[1]);
      if (!q || q.status === 'dismissed') return reply({error: 'not found'}, 404, head);
      return reply({id: q.id, status: q.status, question: q.question, answer: q.answer ?? null, answered: q.answered ?? null}, 200, head);
    }
    if (path === '/api/questions' || (qMatch && qMatch[2])) {
      requireAdmin();
      if (!db) fail(503, 'D1 is not connected.');
      if (!(await questionsReady(db))) fail(503, 'The database needs an update (migration 0003). Run npm run db:remote.');
      const now = Date.now(), text = v => String(v ?? '').trim();
      if (method === 'GET' && path === '/api/questions') return reply(await staffList(db), 200, head);
      if (method === 'POST' && path === '/api/questions') {          // team FAQ, answered up front
        const question = text(body.question), answer = text(body.answer);
        if (!question || question.length > QUESTION_MAX || !answer || answer.length > ANSWER_MAX) fail(400, 'Give a question and an answer.');
        const q = await storeQuestion(db, question, now, campusISO, {status: 'answered', answer, answered: campusISO(now), faq: true});
        return reply(q, 201);
      }
      if (method === 'POST' && qMatch[2] === 'answer') {
        const answer = text(body.answer);
        if (!answer || answer.length > ANSWER_MAX) fail(400, 'Answer must be 1-' + ANSWER_MAX + ' characters.');
        const q = await setAnswer(db, qMatch[1], answer, now, campusISO);
        return q ? reply(q) : reply({error: 'not found'}, 404);
      }
      if (method === 'POST' && qMatch[2] === 'dismiss') {
        const q = await dismiss(db, qMatch[1]);
        return q ? reply(q) : reply({error: 'not found'}, 404);
      }
    }
    return reply({error:'not found'},404,head);
  } catch (error) {
    const known=error instanceof ApiError||error instanceof MobilityError;
    return reply({ok:false,error:known?error.message:'Closure storage or routing is unavailable. Please retry.'},known?error.status:503,head);
  }
}
