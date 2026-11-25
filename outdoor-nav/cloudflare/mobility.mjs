import {haversine, pointSegment, Unreachable} from './router.mjs';

export class MobilityError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const dateFormat = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
export const localDate = ms => dateFormat.format(ms);
const overlaps = (a,b,c,d) => a < d && c < b;
const allowed = (status,credentials) => status === 'open' || status === 'usc_id' && credentials.usc_id || status === 'reservation' && credentials.reservation;
const ll = n => [n.lat,n.lon];
const xy = n => [n.lon,n.lat];
const point = (coord,properties) => ({type:'Feature',geometry:{type:'Point',coordinates:coord},properties});
export const forMode = (rows, mode) => rows.filter(c => (c.modes || ['walking']).includes(mode));

export async function readRules(db,from,to=from+1) {
  if (!db) return [];
  try {
    // One retry: D1 occasionally fails a read for a moment (seen on the map 2026-11-21; a reload fixed it).
    const read = () => db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM mobility_rules WHERE starts_ms<? AND ends_ms>? ORDER BY created_ms,id LIMIT 101)").bind(to,from).first('data');
    const value = await read().catch(() => new Promise(r => setTimeout(r, 250)).then(read));
    const rows=JSON.parse(value);
    if (rows.length>100) throw new MobilityError(503,'More than 100 closures in this period. Lift old ones on the Staff screen.');
    return [...rows,...await readParkingStatus(db,from,to),...await readParkingRates(db,from,to)];
  } catch(error) {
    if(error instanceof MobilityError)throw error;
    // The fix for developers (a missing table: npm run db:local / db:remote) goes to the log;
    // people on the map or Staff screen get a message they can act on.
    console.error('readRules failed (missing migration? run npm run db:local / db:remote):',error);
    throw new MobilityError(503,'Closures and parking updates could not be loaded just now. Try again in a minute; if it keeps happening, tell the Doorstep team.');
  }
}
// Parking statuses ride along with the gate and road rules as kind 'parking'; every
// other reader filters by kind. Before migration 0005 there are none.
async function readParkingStatus(db,from,to) {
  let value;
  try { value=await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM parking_status WHERE starts_ms<? AND ends_ms>? ORDER BY created_ms,id LIMIT 201)").bind(to,from).first('data'); }
  catch { return []; }
  const rows=JSON.parse(value);
  if(rows.length>200)throw new MobilityError(503,'Too many parking statuses. Lift old ones on the Staff screen.');
  return rows;
}

// Parking prices ride along the same way, as kind 'rate'. Before migration 0007 there are none.
async function readParkingRates(db,from,to) {
  let value;
  try { value=await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM parking_rates WHERE starts_ms<? AND ends_ms>? ORDER BY created_ms,id LIMIT 201)").bind(to,from).first('data'); }
  catch { return []; }
  const rows=JSON.parse(value);
  if(rows.length>200)throw new MobilityError(503,'Too many parking rates. Remove old ones on the Staff screen.');
  return rows;
}

// ---- Parking structure status (staff) ----
// "closed": a structure doesn't take these parkers (e.g. no Text2Park Mon-Thu 6 am-4 pm).
// "open" / "filling" / "full": live occupancy, e.g. from radio calls on game days;
// the newest one wins. "daily" = drivers without a permit for that structure.
export const PARKING_STATUSES=['open','filling','full','closed'];
export const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const STALE_MS=2*3600000;
const clockFormat=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function clock(ms){const p=Object.fromEntries(clockFormat.formatToParts(ms).map(x=>[x.type,x.value]));return {day:p.weekday,minute:+p.hour*60+ +p.minute};}
const hhmm=t=>{const m=/^(\d{2}):(\d{2})$/.exec(t||'');if(!m)return null;const v=+m[1]*60+ +m[2];return +m[1]<=24&&+m[2]<60&&v<=1440?v:null;};
export function validateParkingStatus(body,context,now=Date.now()) {
  const p=context.mobilityData.parking.find(x=>x.id===body.parking);
  if(!p)throw new MobilityError(400,'Unknown parking structure.');
  if(!['daily','everyone'].includes(body.applies))throw new MobilityError(400,'Choose who this applies to: daily (Text2Park) parkers or everyone.');
  if(!PARKING_STATUSES.includes(body.status))throw new MobilityError(400,'Choose open, filling, full or closed.');
  const starts=context.time.parseTime(body.starts,now),ends=context.time.parseTime(body.ends,starts+3*3600000);
  if(ends<=starts||ends-starts>120*86400000)throw new MobilityError(400,'Use an end after the start, at most 120 days later.');
  let spaces=null;
  if(body.spaces!==undefined&&body.spaces!==null&&body.spaces!==''){spaces=Number(body.spaces);if(!Number.isInteger(spaces)||spaces<0||spaces>20000)throw new MobilityError(400,'Spaces left must be a whole number.');}
  const rule={id:crypto.randomUUID().replaceAll('-',''),kind:'parking',parking:p.id,parking_name:p.name,applies:body.applies,status:body.status,spaces,
    starts_ms:starts,ends_ms:ends,created_ms:now,starts:context.time.campusISO(starts),ends:context.time.campusISO(ends),updated:context.time.campusISO(now),
    note:String(body.note||'').slice(0,280),source:'staff_confirmed'};
  if(body.days!==undefined&&body.days!==null){
    if(!Array.isArray(body.days)||!body.days.length||body.days.some(d=>!DAYS.includes(d)))throw new MobilityError(400,'Choose at least one day of the week.');
    const from=hhmm(body.from),to=hhmm(body.to);
    if(from===null||to===null||from>=to)throw new MobilityError(400,'Use daily times like 06:00 to 16:00 (start before end).');
    rule.days=DAYS.filter(d=>body.days.includes(d));rule.from=body.from;rule.to=body.to;
  }
  return rule;
}
export function parkingRuleActive(r,when){
  if(!(r.starts_ms<=when&&when<r.ends_ms))return false;
  if(!r.days)return true;
  const c=clock(when);return r.days.includes(c.day)&&hhmm(r.from)<=c.minute&&c.minute<hhmm(r.to);
}
const time12=t=>{const [h,m]=t.split(':').map(Number),hh=h%12||12;return hh+(m?':'+String(m).padStart(2,'0'):'')+(h<12||h===24?' am':' pm');};
// What staff said about this structure for this driver, at this time.
export function parkingSpace(rules,p,when,permit){
  const mine=rules.filter(r=>r.kind==='parking'&&r.parking===p.id&&(r.applies==='everyone'||!permit)&&parkingRuleActive(r,when));
  const closed=mine.filter(r=>r.status==='closed').sort((a,b)=>b.created_ms-a.created_ms)[0];
  const live=mine.filter(r=>r.status!=='closed').sort((a,b)=>b.created_ms-a.created_ms)[0];
  if(!closed&&!live)return null;
  const r=closed||live,endDay=r.ends.slice(0,10)!==localDate(when)?new Date(r.ends.slice(0,10)+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})+', ':'';
  const until=r.days?time12(r.to):endDay+time12(r.ends.slice(11,16));
  const who=r.applies==='daily'?'daily (Text2Park) parking':'parking';
  const reason=closed?`No ${who} until ${until}${r.note?': '+r.note:''}.`
    :live.status==='full'?`Full (staff update ${time12(live.updated.slice(11,16))})${live.note?': '+live.note:''}.`:null;
  return {status:closed?'closed':live.status,applies:r.applies,spaces:live?.spaces??null,updated:(live||closed).updated,
    stale:!!live&&live.status!=='closed'&&when-live.created_ms>STALE_MS,until:r.days?r.to:r.ends,note:r.note||null,reason};
}
// ---- Parking rates (staff) ----
// What a visitor without a permit for the structure pays. hourly (optional daily max),
// daily (all day), event (a flat rate, e.g. a game; while one applies it replaces the
// others) or free. Prices are dollars. A rate can repeat on days and times, like a status.
// An event rate may come with a lower all-day price for people not at the event, with a
// validation code (e.g. a Shrine concert: event price, or $20 validated). Never the code itself.
export const RATE_OPTIONS=['hourly','daily','event','free'];
export const RATE_PAY=['text2park','pay_station','phone_or_station','booth','online','other'];
export function validateParkingRate(body,context,now=Date.now()) {
  const p=context.mobilityData.parking.find(x=>x.id===body.parking);
  if(!p)throw new MobilityError(400,'Unknown parking structure.');
  if(!RATE_OPTIONS.includes(body.option))throw new MobilityError(400,'Choose hourly, all day, event or free.');
  const money=(v,what)=>{const n=Number(v);if(v===''||v===null||v===undefined||!Number.isFinite(n)||n<0||n>500||Math.round(n*100)!==n*100)throw new MobilityError(400,what+' must be a dollar amount from 0 to 500, e.g. 18 or 2.50.');return n;};
  const price=body.option==='free'?0:money(body.price,'The price');
  let max=null;
  if(body.option==='hourly'&&body.max!==undefined&&body.max!==null&&body.max!==''){max=money(body.max,'The daily maximum');if(max<price)throw new MobilityError(400,'The daily maximum must be at least the hourly price.');}
  let validated=null;
  if(body.option==='event'&&body.validated_price!==undefined&&body.validated_price!==null&&body.validated_price!==''){
    const v=money(body.validated_price,'The validated price');if(v>=price)throw new MobilityError(400,'The validated price should be lower than the event price.');
    validated={price:v,how:String(body.validated_how||'').replace(/\s+/g,' ').trim().slice(0,140)||null};
  }
  if(body.pay!==undefined&&body.pay!==null&&body.pay!==''&&!RATE_PAY.includes(body.pay))throw new MobilityError(400,'Unknown way to pay.');
  const starts=context.time.parseTime(body.starts,now),ends=context.time.parseTime(body.ends,starts+365*86400000);
  if(ends<=starts||ends-starts>400*86400000)throw new MobilityError(400,'Use an end after the start, at most 400 days later.');
  const rate={id:crypto.randomUUID().replaceAll('-',''),kind:'rate',parking:p.id,parking_name:p.name,option:body.option,price,max,validated,pay:body.pay||null,
    label:String(body.label||'').replace(/\s+/g,' ').trim().slice(0,80)||null,note:String(body.note||'').slice(0,280),
    starts_ms:starts,ends_ms:ends,created_ms:now,starts:context.time.campusISO(starts),ends:context.time.campusISO(ends),updated:context.time.campusISO(now),source:'staff_confirmed'};
  if(body.days!==undefined&&body.days!==null){
    if(!Array.isArray(body.days)||!body.days.length||body.days.some(d=>!DAYS.includes(d)))throw new MobilityError(400,'Choose at least one day of the week.');
    const from=hhmm(body.from),to=hhmm(body.to);
    if(from===null||to===null||from>=to)throw new MobilityError(400,'Use daily times like 06:00 to 16:00 (start before end).');
    rate.days=DAYS.filter(d=>body.days.includes(d));rate.from=body.from;rate.to=body.to;
  }
  return rate;
}
// The prices that apply at this structure at this time: a staff event or free rate replaces the rest;
// otherwise, per option, the newest staff rate, else USC Transportation's published one
// (mobility.json published_rates, which may apply only in some day/time windows).
// Public fields only (not who posted it).
const inWindow=(w,when)=>{const c=clock(when);return w.days.includes(c.day)&&hhmm(w.from)<=c.minute&&c.minute<hhmm(w.to);};
export function parkingRates(rules,p,when){
  const mine=rules.filter(r=>r.kind==='rate'&&r.parking===p.id&&parkingRuleActive(r,when)).sort((a,b)=>b.created_ms-a.created_ms);
  const event=mine.filter(r=>r.option==='event'||r.option==='free');   // staff said so: it replaces every other price
  const staff=r=>({option:r.option,price:r.price,max:r.max,validated:r.validated||null,pay:r.pay,label:r.label,note:r.note||null,source:'staff',updated:r.updated,until:r.days?r.to:r.ends});
  if(event.length)return event.map(staff);
  const published=(p.published_rates||[]).filter(r=>!r.windows||r.windows.some(w=>inWindow(w,when)));
  return RATE_OPTIONS.flatMap(o=>{const s=mine.find(r=>r.option===o);if(s)return [staff(s)];
    return published.filter(r=>r.option===o).map(r=>{
      // A window may name its own way to pay (Downey: pay station only until 4 pm); pay_from says what changes later today.
      const w=r.windows?.find(x=>inWindow(x,when)),pay=w?.pay||r.pay||null,c=clock(when);
      const next=w&&r.windows.find(x=>x!==w&&x.days.includes(c.day)&&hhmm(x.from)===hhmm(w.to)),later=next?(next.pay||r.pay||null):null;
      return {option:r.option,price:r.price,max:r.max??null,validated:null,pay,label:null,note:r.note||null,source:'published',updated:null,until:null,
        ...(next&&later!==pay?{pay_from:{time:next.from,pay:later}}:{})};});});
}
// Published prices not on sale yet but starting later today (Downey's daily rate before noon): [{option, price, max, from}].
// Not when staff posted a price for that option, or an event or free price.
export function laterRates(rules,p,when){
  const mine=rules.filter(r=>r.kind==='rate'&&r.parking===p.id&&parkingRuleActive(r,when));
  if(mine.some(r=>r.option==='event'||r.option==='free'))return [];
  const now=parkingRates(rules,p,when),c=clock(when);
  return (p.published_rates||[]).filter(r=>r.windows&&!now.some(x=>x.option===r.option)).flatMap(r=>{
    const starts=r.windows.filter(w=>w.days.includes(c.day)&&hhmm(w.from)>c.minute).map(w=>w.from).sort();
    return starts.length?[{option:r.option,price:r.price,max:r.max??null,from:starts[0]}]:[];});
}
// "$3/hour (max $18/day)", "All day $18", "Football vs UCLA: $30", "Free"; plus how to pay.
// The page has the same wording (index.html rateText).
const dollars=n=>'$'+(Number.isInteger(n)?n:n.toFixed(2));
export const RATE_PAY_TEXT={text2park:'Text2Park (+$0.50 fee)',pay_station:'pay station',phone_or_station:'Text2Park (+$0.50 fee) or pay station',booth:'booth',online:'online',other:'see signs'};
export function rateText(r){
  const what=r.option==='free'?'Free':r.option==='hourly'?dollars(r.price)+'/hour'+(r.max!=null?' (max '+dollars(r.max)+'/day)':''):r.option==='daily'?'All day '+dollars(r.price):'Event rate '+dollars(r.price)
    +(r.validated?'; not here for the event: '+dollars(r.validated.price)+' all day with a validation code'+(r.validated.how?' ('+r.validated.how+')':''):'');
  return (r.label?r.label+': ':'')+what+(r.pay?' · pay by '+RATE_PAY_TEXT[r.pay]:'')+(r.note?' · '+r.note:'');
}
// The schedule covers its season's year and the off-season after it: no home games are
// played January to July, so driving keeps working then. From August 1 the next season's
// schedule must be in football.json, or driving routes stop rather than miss a game day.
export const knownSeason=(season,date)=>date.startsWith(String(season)+'-')||(date.startsWith(String(season+1)+'-')&&date<String(season+1)+'-08');
export function footballContext(data,when) {
  const date=localDate(when), game=data.home_games.find(g=>g.date===date);
  return {season:data.season,checked:data.checked,schedule_source:data.schedule_source,traffic_source:data.traffic_source,
    source_note:data.traffic_source_note,known_season:knownSeason(data.season,date),game:game||null,
    policy:game?'precaution_all_day':'none',next:data.home_games.find(g=>g.date>=date)||null,
    home_games:data.home_games};
}
// USC parking permits (from people who park there):
//  - a permit for a structure always lets its holder drive in and park there, even when
//    the public gate hours or game-day rules keep other visitors out;
//  - on weekends a permit for any structure is valid at every structure.
// A permit never overrides a closure that staff confirmed.
export const permitId=(context,value)=>typeof value==='string'&&context.mobilityData.parking.some(p=>p.id===value)?value:null;
export function permitCovers(context,credentials,p,column){
  const permit=permitId(context,credentials.permit);
  return permit!==null&&(permit===p.id||column==='weekend');
}
export function gateState(context,when,rules=[],credentials={}) {
  const {gateData,mobilityData,time}=context;
  return time.gateStatus(gateData,when).map(g=>{
    const byPermit=mobilityData.parking.some(p=>p.gate===g.id&&permitCovers(context,credentials,p,g.vehicle.column));
    const location=mobilityData.gates.find(p=>p.id===g.id);
    const overrides=rules.filter(r=>r.kind==='gate'&&r.gate===g.id&&forCars(r)&&r.starts_ms<=when&&when<r.ends_ms);
    // Only restrictive overrides exist. A staff action must never silently open a gate.
    const vehicle=overrides.length?{...g.vehicle,status:'closed',reason:overrides.map(r=>r.note||'Staff closure').join('; ')}:g.vehicle;
    const open=!!allowed(vehicle.status,credentials),permitAccess=!open&&!overrides.length&&byPermit;
    return {...g,...location,vehicle,eligible:open||permitAccess,permit_access:permitAccess,schedule:gateData.gates.find(p=>p.id===g.id),
      basis:overrides.length?'staff_confirmed':'published_schedule'};
  });
}
// A structure can have several ways in: (gate, entrance, campus leg). Downey is
// reached through McClintock or through the Downey Way gate on Vermont.
// An access option may be usable only in some windows (e.g. Shrine's 32nd St entrance, weekdays 6-6).
export const accessOptions=p=>Array.isArray(p.access)&&p.access.length?p.access:[{gate:p.gate,entrance:p.entrance,campus_via:p.campus_via}];
export function parkingState(context,when,rules=[],credentials={}) {
  const gates=gateState(context,when,rules,credentials),football=footballContext(context.footballData,when);
  return context.mobilityData.parking.map(p=>{
    const node=id=>context.survey.nodes.find(n=>n.id===id),exit=node(p.exit);
    const access=accessOptions(p).map(o=>{const g=gates.find(x=>x.id===o.gate);return {gate:o.gate,gate_name:g?.name,eligible:!!g?.eligible&&(!o.windows||o.windows.some(w=>inWindow(w,when))),entrance:node(o.entrance),campus_via:o.campus_via||[]};});
    // The structure is open if ANY way in is; show the first open one.
    const primary=access.find(o=>o.eligible&&o.entrance)||access[0],gate=gates.find(x=>x.id===primary.gate),entrance=primary.entrance;
    const permit=permitCovers(context,credentials,p,gate?.vehicle.column);
    let reason=null,gameRule=null;
    if(!gate?.eligible) reason=gate?.basis==='staff_confirmed'?'Gate closed by staff.':'Gate is closed or requires access credentials.';
    if(football.game&&p.game_access==='unconfirmed') gameRule='Game-day parking access is unconfirmed.';
    if(football.game&&p.game_access==='parking_pass'&&!credentials.parking_pass) gameRule='Game-day prepaid parking pass required.';
    if(gameRule&&!permit) reason=gameRule;
    const space=parkingSpace(rules,p,when,permit);
    if(!reason&&space?.reason) reason=space.reason;
    // True only when the permit is what lets this driver in (not when the structure is open to everyone).
    const byPermit=permit&&(gate?.permit_access===true||gameRule!==null);
    if(!entrance||!exit) reason='Surveyed entrance or pedestrian exit is missing.';
    const rates=parkingRates(rules,p,when),{published_rates,...pub}=p;
    return {...pub,rates,rates_later:laterRates(rules,p,when),rates_source:rates.some(r=>r.source==='published')?context.mobilityData.rates_source:null,rates_apply:!permit,gate:primary.gate,campus_via:primary.campus_via,access,entrance,exit_node:exit,gate_name:gate?.name,eligible:!reason,reason,permit_access:!reason&&byPermit,occupancy:space?.status||'unknown',space,availability_basis:space?'staff update; spaces are not guaranteed':'gate hours and published access; spaces are not guaranteed'};
  });
}
export function circlePolygon(lat,lon,radius=35) {
  const ring=[];
  for(let i=0;i<=12;i++) {const a=i/12*Math.PI*2;ring.push([lon+Math.cos(a)*radius/(111320*Math.cos(lat*Math.PI/180)),lat+Math.sin(a)*radius/110540]);}
  ring[ring.length-1]=ring[0];
  return {type:'Polygon',coordinates:[ring]};
}
export function corridorPolygons(line,width) {
  return line.slice(1).map((b,i)=>{
    const a=line[i],k=Math.cos((a[1]+b[1])/2*Math.PI/180),dx=(b[0]-a[0])*111320*k,dy=(b[1]-a[1])*110540,len=Math.hypot(dx,dy);
    if(!len) return circlePolygon(a[1],a[0],width);
    const ox=-dy/len*width/(111320*k),oy=dx/len*width/110540;
    return {type:'Polygon',coordinates:[[[a[0]+ox,a[1]+oy],[b[0]+ox,b[1]+oy],[b[0]-ox,b[1]-oy],[a[0]-ox,a[1]-oy],[a[0]+ox,a[1]+oy]]]};
  });
}
function orientation(a,b,c) { return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]); }
function onSegment(p,a,b) { return Math.abs(orientation(a,b,p))<1e-12&&p[0]>=Math.min(a[0],b[0])-1e-12&&p[0]<=Math.max(a[0],b[0])+1e-12&&p[1]>=Math.min(a[1],b[1])-1e-12&&p[1]<=Math.max(a[1],b[1])+1e-12; }
function crosses(a,b,c,d) {
  const x=orientation(a,b,c),y=orientation(a,b,d),z=orientation(c,d,a),w=orientation(c,d,b);
  return x*y<0&&z*w<0||onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b);
}
function inside(p,ring) {
  let result=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[j],b=ring[i]; if(onSegment(p,a,b)) return true;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
  }
  return result;
}
export function intersectsPolygon(coords,polygon) {
  const ring=polygon.coordinates[0];
  const xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]),w=Math.min(...xs),e=Math.max(...xs),s=Math.min(...ys),n=Math.max(...ys);
  return coords.some(p=>p[0]>=w&&p[0]<=e&&p[1]>=s&&p[1]<=n&&inside(p,ring))||coords.slice(1).some((b,i)=>{
    const a=coords[i];if(Math.max(a[0],b[0])<w||Math.min(a[0],b[0])>e||Math.max(a[1],b[1])<s||Math.min(a[1],b[1])>n)return false;
    return ring.slice(1).some((d,j)=>crosses(a,b,ring[j],d));
  });
}
// Closed gates become no-go areas only where we know where the gate is.
// Approximate pins sit in the middle of public intersections (Jefferson/Royal,
// Vermont/36th Pl before it was pinned...): a 35 m circle there closed the PUBLIC street, so on
// evenings and weekends no driving route survived. A closed campus gate must stop
// you entering campus through it, not driving past it.
export const GATE_AVOID_RADIUS_M=12;
// Where a closed gate's no-go circle goes. Usually the pin; a gate pinned close to a public
// street (Royal, 12 m from Jefferson) has an `area` point a little way into campus, so its
// circle never closes the street outside it.
export const gateArea=g=>Array.isArray(g.area)?{lat:g.area[0],lon:g.area[1]}:{lat:g.lat,lon:g.lon};
const knownGate=g=>g.lat!==undefined&&g.location_source!=='approximate_intersection';
export function avoidance(context,when,end,rules,credentials={}) {
  const until=Math.max(when+1,end),gates=gateState(context,when,rules,credentials),laterGates=gateState(context,until,rules,credentials),areas=[];
  for(const gate of gates) {
    if(!knownGate(gate)||gate.pedestrian_only) continue;   // a gate for people on foot never closes a road
    // Check both trip ends and all intervening staff restrictions, conservatively.
    const later=laterGates.find(g=>g.id===gate.id);
    if(!gate.eligible||!later.eligible||rules.some(r=>r.kind==='gate'&&r.gate===gate.id&&forCars(r)&&overlaps(when,until,r.starts_ms,r.ends_ms)))
      areas.push({id:'gate:'+gate.id,name:gate.name,basis:gate.basis,geometry:circlePolygon(gateArea(gate).lat,gateArea(gate).lon,GATE_AVOID_RADIUS_M)});
  }
  for(const rule of rules) if(rule.kind==='road'&&forCars(rule)&&overlaps(when,until,rule.starts_ms,rule.ends_ms))
    areas.push({id:rule.id,name:rule.note||'Staff road closure',basis:'staff_confirmed',geometry:rule.geometry});
  // Check every LA calendar date touched by the trip; an away game never activates this.
  const dates=new Set();for(let ms=when;ms<until;ms+=3600000)dates.add(localDate(ms));dates.add(localDate(until));
  if(context.footballData.home_games.some(g=>dates.has(g.date)))
    for(const corridor of context.footballData.precaution_corridors) for(const geometry of corridorPolygons(corridor.line,corridor.width_m))
      areas.push({id:'precaution:'+corridor.id,name:corridor.name,basis:'precaution_not_confirmed',geometry});
  return areas;
}
export function mobilityState(context,when,rules,credentials={}) {
  return {at:context.time.campusISO(when),timezone:'America/Los_Angeles',checked:context.mobilityData.checked,
    gates:gateState(context,when,rules,credentials),parking:parkingState(context,when,rules,credentials),
    football:footballContext(context.footballData,when),rules:rules.filter(r=>r.kind!=='rate'&&r.starts_ms<=when&&when<r.ends_ms).map(({by,...r})=>r),   // rates are under parking[]; who posted is staff-only
    avoid:avoidance(context,when,when+1,rules,credentials),entrance_document:context.mobilityData.entrance_document,
    gate_locations_note:context.mobilityData.gate_locations_note};
}
// Who a staff rule closes: cars, people on foot, or both. Rules saved before this
// field existed are car rules.
export const ruleModes=r=>Array.isArray(r.modes)&&r.modes.length?r.modes:['driving'];
export const forCars=r=>ruleModes(r).includes('driving');
export const GATE_WALK_RADIUS_M=15;
export function validateRule(body,context,now=Date.now()) {
  if(!['gate','road'].includes(body.kind))throw new MobilityError(400,'Choose gate or road.');
  const starts=context.time.parseTime(body.starts,now),ends=context.time.parseTime(body.ends,starts+3600000);
  if(ends<=starts||ends-starts>7*86400000)throw new MobilityError(400,'Use a closure interval of at most seven days.');
  const rule={id:crypto.randomUUID().replaceAll('-',''),kind:body.kind,starts_ms:starts,ends_ms:ends,created_ms:now,
    starts:context.time.campusISO(starts),ends:context.time.campusISO(ends),note:String(body.note||'Staff confirmed closure').slice(0,280),source:'staff_confirmed'};
  const modes=body.modes===undefined?['driving']:body.modes;
  if(!Array.isArray(modes)||!modes.length||modes.some(m=>!['walking','driving'].includes(m)))throw new MobilityError(400,'Closed to: choose cars, people on foot, or both.');
  rule.modes=[...new Set(modes)];
  if(body.kind==='gate') {
    if(!context.gateData.gates.some(g=>g.id===body.gate))throw new MobilityError(400,'Unknown gate.');rule.gate=body.gate;
    // On foot, a gate closure blocks paths near its pin -- only safe where the pin was surveyed.
    const loc=context.mobilityData.gates.find(g=>g.id===body.gate);
    if(rule.modes.includes('walking')&&!(loc&&loc.lat!==undefined&&loc.location_source!=='approximate_intersection'))
      throw new MobilityError(400,"This gate's map position is approximate, so it can't be closed on foot. Draw an area closure at the gate instead.");
  } else {
    const ring=body.geometry?.coordinates?.[0];
    if(body.geometry?.type!=='Polygon'||body.geometry.coordinates.length!==1||!Array.isArray(ring)||ring.length<4||ring.length>65||ring.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<-118.32||p[0]>-118.25||p[1]<33.99||p[1]>34.05)||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])
      throw new MobilityError(400,'Draw one closed campus-area polygon (4–65 points, longitude/latitude).');
    let area=0;for(let i=1;i<ring.length;i++){area+=ring[i-1][0]*ring[i][1]-ring[i][0]*ring[i-1][1];for(let j=i+2;j<ring.length;j++)if(!(i===1&&j===ring.length-1)&&crosses(ring[i-1],ring[i],ring[j-1],ring[j]))throw new MobilityError(400,'Polygon edges must not cross.');}
    if(Math.abs(area)<1e-10)throw new MobilityError(400,'Draw an area, not a straight line.');
    rule.geometry={type:'Polygon',coordinates:[ring]};
  }
  return rule;
}

// App-wide caps on openrouteservice Directions, set so we never trip the provider's own
// limits on its free Standard plan (40 a minute in any sliding 60 s, 2,000 a day counted
// from the first request). Our counters use fixed clock minutes and UTC days, so a burst
// across a boundary can count twice: 20 a minute and 1,000 a day keep us at or under the
// provider's numbers in every case. Raise both only with a larger openrouteservice plan.
export const DIRECTIONS_LIMITS={minute:20,day:1000};
async function reserveQuota(db,kind='driving') {
  const now=Date.now();
  // Atomic, account-wide limits (driving: DIRECTIONS_LIMITS; public reports: 10/minute, 100/day).
  // Limits apply to the upstream calls, including candidate retries, not page views.
  for(const [prefix,size,limit] of [['day',86400000,kind==='report'?100:DIRECTIONS_LIMITS.day],['minute',60000,kind==='report'?10:DIRECTIONS_LIMITS.minute]]) {
    const slot=(kind==='report'?'report:':'')+prefix+':'+Math.floor(now/size);
    const count=await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET count=count+1 WHERE count<? RETURNING count').bind(slot,now+size*2,limit).first('count');
    if(!count)throw new MobilityError(429,kind==='report'?'Public report limit reached. Staff can still post.':'App driving request limit reached. Try later; walking is still available.');
  }
  await db.prepare('DELETE FROM routing_usage WHERE expires_ms<?').bind(now).run();
}
export const reserveReportQuota=db=>reserveQuota(db,'report');
/** How much of the shared openrouteservice allowance is used now (staff stats page). */
export async function orsUsage(db,geocodeLimits,now=Date.now()){
  const minute=Math.floor(now/60000),day=Math.floor(now/86400000);
  const used=async slot=>{try{return (await db.prepare('SELECT count FROM routing_usage WHERE slot=?').bind(slot).first('count'))||0;}catch{return 0;}};
  return {
    directions:{minute:{used:await used('minute:'+minute),limit:DIRECTIONS_LIMITS.minute},day:{used:await used('day:'+day),limit:DIRECTIONS_LIMITS.day},
      note:'Drive + park. One route search uses 1 request, 2 if the first parking choice fails. A moving driver re-routes at most every 45 s.'},
    geocode:{minute:{used:await used('geocode:minute:'+minute),limit:geocodeLimits.minute},day:{used:await used('geocode:day:'+day),limit:geocodeLimits.day},
      note:'Typed street addresses in the start box.'},
    day_basis:'UTC day; openrouteservice counts its day from the first request'};
}
async function directions(coordinates,areas,key,fetcher,db,radiuses=coordinates.map(()=>25)) {
  const body={coordinates,radiuses,instructions:true,geometry_simplify:false,units:'m',language:'en',
    options:{avoid_polygons:{type:'MultiPolygon',coordinates:areas.map(a=>a.geometry.coordinates)}}};
  if(!areas.length)delete body.options;
  await reserveQuota(db);
  let response;
  try { response=await fetcher('https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson',{method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(14000)}); }
  catch {throw new MobilityError(502,'Driving provider is unavailable. Retry later.');}
  if(response.status===429)throw new MobilityError(429,'Driving API quota reached. Wait before retrying.');
  if(response.status===401||response.status===403){
    // openrouteservice answers 403 when the DAILY quota is used up, not only for a bad key.
    let text='';try{text=await response.text();}catch{}
    if(response.status===403&&/quota|limit/i.test(text))throw new MobilityError(429,'Driving API daily quota reached. Try again tomorrow.');
    throw new MobilityError(503,'Driving API key is missing or not authorized. Staff should check ORS_API_KEY.');
  }
  if(!response.ok) { if(response.status>=500)throw new MobilityError(502,'Driving provider is unavailable.');
    let detail='';try{const e=await response.json();detail=String(e?.error?.message||e?.error||'').slice(0,200);}catch{}
    return {failed:response.status,detail}; }
  let data;try{data=await response.json();}catch{throw new MobilityError(502,'Invalid driving provider response.');}
  const feature=data?.features?.[0],coords=feature?.geometry?.coordinates,summary=feature?.properties?.summary;
  if(feature?.geometry?.type!=='LineString'||!Array.isArray(coords)||coords.length<2||coords.length>30000||coords.some(p=>!Array.isArray(p)||p.length<2||!p.slice(0,2).every(Number.isFinite))||!Number.isFinite(summary?.duration)||summary.duration<0||summary.duration>21600||!Number.isFinite(summary.distance)||summary.distance<0)
    throw new MobilityError(502,'Invalid driving route geometry.');
  return feature;
}

// A driver usually starts somewhere off the road (a building, a park, a lot), so
// the route may begin up to this far away; the gap is drawn as a dotted line.
// The END must still be within 30 m of the parking entrance.
export const START_TO_ROAD_LIMIT_M=300;
// Parking mouths sit on campus service roads tagged private in OSM, which the
// provider will not drive (live: "Could not find routable point within 25 m of
// coordinate 2"). The route may end on the nearest drivable road up to this far
// from the entrance; the rest is drawn dotted. Different structures' entrances
// are >= 176 m apart, so this cannot land at the wrong structure.
export const END_TO_ENTRANCE_LIMIT_M=150;
// Speed on campus roads (gate -> structure): slow, pedestrians everywhere.
export const CAMPUS_DRIVE_MPS=4.5;
// Public roads end at the gate; the campus leg follows surveyed points to the entrance.
function wayIn(context,gate,p) {
  const hasGate=gate.lat!==undefined,target=hasGate?{lat:gate.lat,lon:gate.lon}:p.entrance;
  const campus=hasGate?[xy(target),...(p.campus_via||[]).map(id=>context.survey.nodes.find(n=>n.id===id)).filter(Boolean).map(xy),xy(p.entrance)]:[];
  const campusM=campus.slice(1).reduce((sum,c,i)=>sum+haversine([campus[i][1],campus[i][0]],[c[1],c[0]]),0);
  return {hasGate,target,campus,campusM,campusS:campusM/CAMPUS_DRIVE_MPS};
}
// Where a phone's maps app should drive to: the gate (public roads end there).
const driveTo=(gate,p,target)=>({lat:target.lat,lon:target.lon,name:gate.lat!==undefined?gate.name:p.name,
  approximate:gate.lat!==undefined&&!knownGate(gate)});

// No driving line from us: the best-ranked structure, its gate and campus leg, and
// our walk from it. The page offers Google / Apple Maps for the drive to the gate.
function handoffOnly(context,body,when,building,p,rules,credentials,walking,why) {
  const gate=gateState(context,when,rules,credentials).find(g=>g.id===p.gate);
  const {hasGate,target,campus,campusM}=wayIn(context,gate,p);
  const arrival=when+1800000;      // no drive time without a provider: check the walk half an hour out
  let walk;
  try{walk=context.router.route({building:building.id,place:p.id,exit:p.exit,stepFree:body.step_free===true,
    closures:walking.filter(c=>c.status==='approved'&&context.time.parseTime(c.starts)<=arrival&&arrival<context.time.parseTime(c.ends)),
    reports:walking.filter(c=>c.status==='unverified')});}
  catch(error){if(error instanceof Unreachable)return {ok:false,reason:'Driving directions are busy and no walking route was found from '+p.name+'. Try another parking structure.'};throw error;}
  const exit=context.survey.nodes.find(n=>n.id===p.exit);
  const features=[point(xy(target),{kind:'gate',name:gate.name}),point(xy(p.entrance),{kind:'parking',name:p.name})];
  if(campus.length>1)features.unshift({type:'Feature',properties:{kind:'campus',metres:Math.round(campusM)},geometry:{type:'LineString',coordinates:campus}});
  return {ok:true,type:'FeatureCollection',mode:'driving',handoff_only:true,why,features,
    summary:{minutes:null,metres:null,start_to_road_m:0,campus_m:Math.round(campusM),walking_minutes:walk.summary.minutes,
      building:building.id,building_name:building.name,parking:p,gate,drive_to:driveTo(gate,p,target),storage:'d1',
      provider:null,live_traffic:false,provider_requests:0,
      selection:'Ranked by distance only: driving directions were '+(why==='busy'?'busy':'unavailable')+'.'},
    steps:hasGate?[{instruction:'Enter campus at '+gate.name+', then about '+Math.round(campusM)+' m on campus roads to '+p.name,distance:Math.round(campusM)}]:[],
    walking_preview:walk,handoff:{action:'parked',parking:p.id,exit:p.exit,lat:exit?.lat??null,lon:exit?.lon??null,building:building.id}};
}

export async function drivingRoute(context,body,when,rules,closures,env,fetcher=fetch) {
  if(!env.ORS_API_KEY)throw new MobilityError(503,'Driving needs an openrouteservice API key. Staff: run npm run secret:routing, then npm run deploy.');
  if(!env.DB)throw new MobilityError(503,'Connect D1 before using driving routes and live gate restrictions.');
  if(!footballContext(context.footballData,when).known_season)throw new MobilityError(503,'Football schedule for this year is not registered. Staff must update the schedule before driving routes are offered.');
  if(body.permit!==undefined&&body.permit!==null&&body.permit!==''&&permitId(context,body.permit)===null)throw new MobilityError(400,'Unknown parking permit.');
  const credentials={usc_id:body.usc_id===true,parking_pass:body.parking_pass===true,reservation:body.reservation===true,permit:permitId(context,body.permit)};
  const origin=body.from;if(!origin||!Number.isFinite(origin.lat)||!Number.isFinite(origin.lon)||Math.abs(origin.lat)>90||Math.abs(origin.lon)>180)throw new MobilityError(400,'Driving requires a numeric GPS/map origin.');
  if(haversine(ll(origin),[34.021,-118.285])>90000)throw new MobilityError(400,'Driving preview supports starts within 90 km of USC.');
  const building=context.router.findBuilding(body.to);
  if(!building)throw new Unreachable('Choose a specific destination building.',[],context.router.candidates(body.to).map(b=>({id:b.id,name:b.name})));
  const parking=parkingState(context,when,rules,credentials);
  if(body.parking&&body.parking!=='auto'&&!parking.some(p=>p.id===body.parking))throw new MobilityError(400,'Unknown parking structure.');
  const walking=forMode(closures,'walking'),driving=forMode(closures,'driving').filter(c=>c.status==='approved');
  const candidates=[];
  // One candidate per open way in (gate + entrance): the router can enter Downey
  // through the Downey Way gate when it is open and nearer, McClintock otherwise.
  const gatesNow=gateState(context,when,rules,credentials);
  for(const p of parking.filter(p=>p.eligible&&(!body.parking||body.parking==='auto'||p.id===body.parking))) {
    for(const o of p.access.filter(o=>o.eligible&&o.entrance)) {
      const g=gatesNow.find(x=>x.id===o.gate),door=g&&g.lat!==undefined?[g.lat,g.lon]:ll(o.entrance);
      const score=haversine(ll(p.exit_node),[building.lat,building.lon])/81+haversine(ll(origin),door)/500+haversine(door,ll(o.entrance))/300+(p.occupancy==='filling'?5:0);
      candidates.push({p:{...p,gate:o.gate,gate_name:o.gate_name,entrance:o.entrance,campus_via:o.campus_via},score});
    }
  }
  candidates.sort((a,b)=>a.score-b.score);
  if(!candidates.length)return {ok:false,reason:'No parking route works at this time. Check the gate hours and whether you need a USC ID or permit, or choose another structure.',parking};
  const reportAreas=driving.map(c=>({id:c.id,name:c.note||'Approved blockage',basis:'staff_confirmed',geometry:circlePolygon(c.lat,c.lon,c.radius_m||15)}));
  let attempts=0;const checks=[],found=[];const reject=(p,check,extra={})=>checks.push({parking:p.id,check,...extra});
  // A bounded number of requests protects the free-tier quota; choose a specific
  // structure to try one outside this shortlist. This is not global optimization.
  for(const {p} of candidates.slice(0,2)) {
    const gate=gateState(context,when,rules,credentials).find(g=>g.id===p.gate);
    // Drive on public roads TO THE GATE. The gate -> structure leg is on campus
    // roads, which the provider will not drive (tagged private in OSM): asked to
    // continue to the entrance, it touched the gate, turned back and parked on the
    // nearest public street instead. The campus leg follows surveyed points where
    // we have them (Downey: down McClintock to the Downey Way intersection).
    const {hasGate,target,campus,campusM,campusS}=wayIn(context,gate,p);
    const targetRadius=hasGate?(knownGate(gate)?30:60):END_TO_ENTRANCE_LIMIT_M;
    const coordinates=[xy(origin),xy(target)],radiuses=[START_TO_ROAD_LIMIT_M,targetRadius];
    // Start with a conservative horizon; recheck the exact resulting arrival.
    const horizon=when+Math.max(1800000,haversine(ll(origin),ll(p.entrance))/5*1000);
    const areas=[...avoidance(context,when,horizon,rules,credentials),...reportAreas];
    if(areas.some(a=>intersectsPolygon([xy(origin)],a.geometry)||intersectsPolygon([xy(p.entrance)],a.geometry))){reject(p,'start or entrance inside an avoided area');continue;}
    attempts++;
    let feature;
    try{feature=await directions(coordinates,areas,env.ORS_API_KEY,fetcher,env.DB,radiuses);}
    catch(error){
      // Our cap or openrouteservice's ran out, or the service is down: the phone's
      // own maps app drives them to the gate instead, and Doorstep does the walk.
      if(error instanceof MobilityError&&(error.status===429||error.status===502)&&!found.length)
        return handoffOnly(context,body,when,building,candidates[0].p,rules,credentials,walking,error.status===429?'busy':'unavailable');
      if(error instanceof MobilityError&&(error.status===429||error.status===502))break;
      throw error;
    }
    if(!feature||feature.failed){reject(p,'provider returned no route',feature?{status:feature.failed,detail:feature.detail}:{});continue;}
    const coords=feature.geometry.coordinates,duration=feature.properties.summary.duration+campusS,arrival=when+duration*1000;
    const actual=[...avoidance(context,when,arrival,rules,credentials),...reportAreas];
    const crossed=actual.filter(a=>intersectsPolygon(coords,a.geometry)||(campus.length>1&&intersectsPolygon(campus,a.geometry)));
    if(crossed.length){reject(p,'route crosses an avoided area',{areas:crossed.map(a=>a.name||a.id)});continue;}
    const toRoad=haversine([coords[0][1],coords[0][0]],ll(origin));
    const endGap=haversine([coords.at(-1)[1],coords.at(-1)[0]],ll(target));
    if(toRoad>START_TO_ROAD_LIMIT_M){reject(p,'route starts too far from you',{metres:Math.round(toRoad)});continue;}
    if(endGap>targetRadius+10){reject(p,hasGate?'route does not reach the gate':'route does not reach the parking entrance',{metres:Math.round(endGap),gate:hasGate?gate.id:undefined});continue;}
    if(!parkingState(context,arrival,rules,credentials).find(row=>row.id===p.id)?.eligible){reject(p,'parking not available at arrival time');continue;}
    // Check every mapped gate touched by the polyline at the approximate crossing
    // time, as well as departure/arrival. A route is discarded on any violation.
    let cumulative=0;const distances=coords.slice(1).map((c,i)=>haversine([coords[i][1],coords[i][0]],[c[1],c[0]])),total=distances.reduce((x,y)=>x+y,0)||1;
    let invalid=false;
    const mappedGates=gateState(context,when,rules,credentials).filter(knownGate);
    for(let i=1;i<coords.length;i++) {
      for(const g of mappedGates) {
        if(pointSegment(ll(g),[coords[i-1][1],coords[i-1][0]],[coords[i][1],coords[i][0]])<=GATE_AVOID_RADIUS_M) {
          for(const fraction of [cumulative/total,(cumulative+distances[i-1])/total])
            if(!gateState(context,when+duration*1000*fraction,rules,credentials).find(row=>row.id===g.id)?.eligible)invalid=g.id;
        }
      }
      cumulative+=distances[i-1];
    }
    if(invalid){reject(p,'route passes a closed gate',{gate:invalid});continue;}
    // Revalidate the walking continuation at arrival, not at departure.
    let arrivalWalk;
    try{arrivalWalk=context.router.route({building:building.id,place:p.id,exit:p.exit,stepFree:body.step_free===true,
      closures:walking.filter(c=>c.status==='approved'&&context.time.parseTime(c.starts)<=arrival&&arrival<context.time.parseTime(c.ends)),
      reports:walking.filter(c=>c.status==='unverified')});}
    catch(error){if(error instanceof Unreachable){reject(p,'no walking route from the parking exit');continue;}throw error;}
    const extra=toRoad>10?[{type:'Feature',properties:{kind:'to_road',metres:Math.round(toRoad)},geometry:{type:'LineString',coordinates:[xy(origin),coords[0]]}}]:[];
    if(campus.length>1)extra.push({type:'Feature',properties:{kind:'campus',metres:Math.round(campusM)},geometry:{type:'LineString',coordinates:[coords.at(-1),...campus.slice(1)]}});
    const steps=(feature.properties.segments||[]).flatMap(seg=>seg.steps||[]).map(st=>({instruction:st.instruction,distance:st.distance,duration:st.duration}));
    if(hasGate)steps.push({instruction:'Enter campus at '+gate.name+', then about '+Math.round(campusM)+' m on campus roads to '+p.name,distance:Math.round(campusM),duration:Math.round(campusS)});
    found.push({ok:true,type:'FeatureCollection',mode:'driving',features:[...extra,{...feature,properties:{...feature.properties,kind:'route',mode:'driving'}},
      point(xy(target),{kind:'gate',name:gate.name}),point(xy(p.entrance),{kind:'parking',name:p.name})],
      summary:{minutes:Math.round(duration/6)/10,metres:Math.round(feature.properties.summary.distance+campusM),start_to_road_m:Math.round(toRoad),campus_m:Math.round(campusM),walking_minutes:arrivalWalk.summary.minutes,
        building:building.id,building_name:building.name,parking:p,gate,drive_to:driveTo(gate,p,target),arrival:context.time.campusISO(arrival),storage:'d1',
        avoided:actual.map(a=>({id:a.id,name:a.name,basis:a.basis})),provider:'openrouteservice',live_traffic:false,
        gate_locations_note:context.mobilityData.gate_locations_note,selection:'First valid candidate among at most two ranked parking options; not a guaranteed fastest route.',provider_requests:attempts},
      steps,
      walking_preview:arrivalWalk,handoff:{action:'parked',parking:p.id,exit:p.exit,lat:p.exit?context.survey.nodes.find(n=>n.id===p.exit).lat:null,
        lon:p.exit?context.survey.nodes.find(n=>n.id===p.exit).lon:null,building:building.id},
      attribution:'© openrouteservice.org by HeiGIT | © OpenStreetMap contributors (ODbL)'});
  }
  // Both shortlisted ways in were asked; keep the faster DOOR TO DOOR: drive
  // (provider time + campus leg) plus the walk from the structure. Comparing the
  // drive alone picked a structure with a 10-minute walk over one with 1 minute.
  if(found.length){found.sort((a,b)=>(a.summary.minutes+a.summary.walking_minutes)-(b.summary.minutes+b.summary.walking_minutes));found[0].summary.provider_requests=attempts;return found[0];}
  return {ok:false,reason:'No route passed the gate and closure checks. Try another parking structure or wait for staff access updates.',provider_requests:attempts,checks,parking};
}

/** Staff rules that close paths ON FOOT, as walking closures for the router:
 *  an area becomes a polygon closure, a (surveyed) gate a small circle. */
export function walkingRuleClosures(context,rules,when) {
  const out=[];
  for(const r of rules){
    if(!ruleModes(r).includes('walking')||!(r.starts_ms<=when&&when<r.ends_ms))continue;
    const base={id:'rule:'+r.id,status:'approved',source:'official',modes:['walking'],note:r.note,ends:r.ends};
    if(r.kind==='road'&&r.geometry)out.push({...base,polygon:r.geometry.coordinates[0]});
    else if(r.kind==='gate'){const g=context.mobilityData.gates.find(x=>x.id===r.gate);if(g&&g.lat!==undefined)out.push({...base,...gateArea(g),radius_m:GATE_WALK_RADIUS_M});}
  }
  return out;
}

// ---- Gates on a pedestrian schedule (soft) ----
// The DPS schedule is official but not kept strictly, so a gate scheduled closed
// on foot is a preference, not a wall: avoid it when the detour is small (bigger
// detours are worth it at night, when gates really are locked), otherwise walk
// through it with a note naming the nearest gate scheduled open. Only staff
// closures block outright. Wording states the schedule, never how it's kept.
export const SOFT_GATE={day_min:2,night_min:8,varies_min:2,night_from:22*60,night_to:5*60};
function nearLine(route,lat,lon,radius){
  const line=route.features?.find(f=>f.geometry?.type==='LineString')?.geometry.coordinates||[];
  for(let i=1;i<line.length;i++)if(pointSegment([lat,lon],[line[i-1][1],line[i-1][0]],[line[i][1],line[i][0]])<=radius)return true;
  return false;
}
export function softGates(context,when,rules,first,reroute){
  const status=context.time.gateStatus(context.gateData,when),c=clock(when),night=c.minute>=SOFT_GATE.night_from||c.minute<SOFT_GATE.night_to;
  const staffClosed=new Set(rules.filter(r=>r.kind==='gate'&&ruleModes(r).includes('walking')&&r.starts_ms<=when&&when<r.ends_ms).map(r=>r.gate));
  const pin=id=>context.mobilityData.gates.find(g=>g.id===id&&knownGate(g));
  const scheduled=status.filter(g=>['closed','varies'].includes(g.pedestrian?.status)&&pin(g.id)&&!staffClosed.has(g.id));
  const crossed=scheduled.filter(g=>{const p=gateArea(pin(g.id));return nearLine(first,p.lat,p.lon,GATE_WALK_RADIUS_M);});
  if(!crossed.length)return {route:first,notes:[]};
  // A gate seen kept locked (not just scheduled closed) is always avoided when there is another way.
  const limit=crossed.some(g=>g.pedestrian.locked)?Infinity:crossed.some(g=>g.pedestrian.status==='closed')?(night?SOFT_GATE.night_min:SOFT_GATE.day_min):SOFT_GATE.varies_min;
  const ids=new Set(crossed.map(g=>'schedule:'+g.id));
  const names=crossed.map(g=>g.name).join(' and ');
  let alt=null;
  try{alt=reroute(crossed.map(g=>{const p=gateArea(pin(g.id));return {id:'schedule:'+g.id,lat:p.lat,lon:p.lon,radius_m:GATE_WALK_RADIUS_M,status:'approved',modes:['walking'],note:g.name+' (scheduled closed on foot)'};}));}catch{}
  const extra=alt?Math.round((alt.summary.minutes-first.summary.minutes)*10)/10:null;
  if(alt&&extra<=limit){
    alt.summary.avoided=alt.summary.avoided.filter(a=>!ids.has(a.closure?.id??a.closure));
    return {route:alt,notes:[{kind:'avoided',gates:crossed.map(g=>g.id),text:`Avoiding ${names}: ${crossed.some(g=>g.pedestrian.locked)?'kept locked to people on foot':'scheduled closed on foot now'}${extra>0?` (about ${extra} extra min)`:''}.`}]};
  }
  // Keep the direct route; say where to go if it's locked.
  const open=status.filter(g=>g.pedestrian?.status==='open'&&context.mobilityData.gates.find(x=>x.id===g.id&&x.lat!==undefined));
  const from=pin(crossed[0].id),nearest=open.map(g=>{const p=context.mobilityData.gates.find(x=>x.id===g.id);return {g,d:haversine([from.lat,from.lon],[p.lat,p.lon])};}).sort((a,b)=>a.d-b.d)[0]?.g;
  return {route:first,notes:[{kind:'through',gates:crossed.map(g=>g.id),text:`This route goes through ${names}, which is scheduled closed on foot now. It may be locked${nearest?`; the nearest gate scheduled open is ${nearest.name}`:''}.`}]};
}
