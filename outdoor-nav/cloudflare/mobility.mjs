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
    const value = await db.prepare("SELECT COALESCE(json_group_array(json(payload)), '[]') AS data FROM (SELECT payload FROM mobility_rules WHERE starts_ms<? AND ends_ms>? ORDER BY created_ms,id LIMIT 101)").bind(to,from).first('data');
    const rows=JSON.parse(value);
    if (rows.length>100) throw new Error('limit');
    return rows;
  } catch { throw new MobilityError(503,'Mobility storage is unavailable. Run npm run db:local and npm run db:remote for the new migration.'); }
}
export function footballContext(data,when) {
  const date=localDate(when), game=data.home_games.find(g=>g.date===date);
  return {season:data.season,checked:data.checked,schedule_source:data.schedule_source,traffic_source:data.traffic_source,
    source_note:data.traffic_source_note,known_season:date.startsWith(String(data.season)+'-'),game:game||null,
    policy:game?'precaution_all_day':'none',next:data.home_games.find(g=>g.date>=date)||null,
    home_games:data.home_games};
}
export function gateState(context,when,rules=[],credentials={}) {
  const {gateData,mobilityData,time}=context;
  return time.gateStatus(gateData,when).map(g=>{
    const location=mobilityData.gates.find(p=>p.id===g.id);
    const overrides=rules.filter(r=>r.kind==='gate'&&r.gate===g.id&&r.starts_ms<=when&&when<r.ends_ms);
    // Only restrictive overrides exist. A staff action must never silently open a gate.
    const vehicle=overrides.length?{...g.vehicle,status:'closed',reason:overrides.map(r=>r.note||'Staff closure').join('; ')}:g.vehicle;
    return {...g,...location,vehicle,eligible:!!allowed(vehicle.status,credentials),schedule:gateData.gates.find(p=>p.id===g.id),
      basis:overrides.length?'staff_confirmed':'published_schedule'};
  });
}
export function parkingState(context,when,rules=[],credentials={}) {
  const gates=gateState(context,when,rules,credentials),football=footballContext(context.footballData,when);
  return context.mobilityData.parking.map(p=>{
    const gate=gates.find(g=>g.id===p.gate), entrance=context.survey.nodes.find(n=>n.id===p.entrance),exit=context.survey.nodes.find(n=>n.id===p.exit);
    let reason=null;
    if(!gate?.eligible) reason='Gate is closed or requires access credentials.';
    if(football.game&&p.game_access==='unconfirmed') reason='Game-day parking access is unconfirmed.';
    if(football.game&&p.game_access==='parking_pass'&&!credentials.parking_pass) reason='Game-day prepaid parking pass required.';
    if(!entrance||!exit) reason='Surveyed entrance or pedestrian exit is missing.';
    return {...p,entrance,exit_node:exit,gate_name:gate?.name,eligible:!reason,reason,occupancy:'unknown',availability_basis:'gate hours and published access; spaces are not guaranteed'};
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
export function avoidance(context,when,end,rules,credentials={}) {
  const until=Math.max(when+1,end),gates=gateState(context,when,rules,credentials),laterGates=gateState(context,until,rules,credentials),areas=[];
  for(const gate of gates) {
    if(gate.lat===undefined) continue;
    // Check both trip ends and all intervening staff restrictions, conservatively.
    const later=laterGates.find(g=>g.id===gate.id);
    if(!gate.eligible||!later.eligible||rules.some(r=>r.kind==='gate'&&r.gate===gate.id&&overlaps(when,until,r.starts_ms,r.ends_ms)))
      areas.push({id:'gate:'+gate.id,name:gate.name,basis:gate.basis,geometry:circlePolygon(gate.lat,gate.lon,35)});
  }
  for(const rule of rules) if(rule.kind==='road'&&overlaps(when,until,rule.starts_ms,rule.ends_ms))
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
    football:footballContext(context.footballData,when),rules:rules.filter(r=>r.starts_ms<=when&&when<r.ends_ms),
    avoid:avoidance(context,when,when+1,rules,credentials),entrance_document:context.mobilityData.entrance_document,
    gate_locations_note:context.mobilityData.gate_locations_note};
}
export function validateRule(body,context,now=Date.now()) {
  if(!['gate','road'].includes(body.kind))throw new MobilityError(400,'Choose gate or road.');
  const starts=context.time.parseTime(body.starts,now),ends=context.time.parseTime(body.ends,starts+3600000);
  if(ends<=starts||ends-starts>7*86400000)throw new MobilityError(400,'Use a closure interval of at most seven days.');
  const rule={id:crypto.randomUUID().replaceAll('-',''),kind:body.kind,starts_ms:starts,ends_ms:ends,created_ms:now,
    starts:context.time.campusISO(starts),ends:context.time.campusISO(ends),note:String(body.note||'Staff confirmed closure').slice(0,280),source:'staff_confirmed'};
  if(body.kind==='gate') {
    if(!context.gateData.gates.some(g=>g.id===body.gate))throw new MobilityError(400,'Unknown gate.');rule.gate=body.gate;
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

async function reserveQuota(db,kind='driving') {
  const now=Date.now();
  // Atomic, account-wide limits: at most 10 upstream requests/minute and 500/day.
  // Limits apply to the upstream calls, including candidate retries, not page views.
  for(const [prefix,size,limit] of [['day',86400000,kind==='report'?100:500],['minute',60000,10]]) {
    const slot=(kind==='report'?'report:':'')+prefix+':'+Math.floor(now/size);
    const count=await db.prepare('INSERT INTO routing_usage(slot,count,expires_ms) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET count=count+1 WHERE count<? RETURNING count').bind(slot,now+size*2,limit).first('count');
    if(!count)throw new MobilityError(429,kind==='report'?'Public report limit reached. Staff can still post.':'App driving request limit reached. Try later; walking is still available.');
  }
  await db.prepare('DELETE FROM routing_usage WHERE expires_ms<?').bind(now).run();
}
export const reserveReportQuota=db=>reserveQuota(db,'report');
async function directions(coordinates,areas,key,fetcher,db) {
  const body={coordinates,radiuses:coordinates.map(()=>25),instructions:true,geometry_simplify:false,units:'m',language:'en',
    options:{avoid_polygons:{type:'MultiPolygon',coordinates:areas.map(a=>a.geometry.coordinates)}}};
  if(!areas.length)delete body.options;
  await reserveQuota(db);
  let response;
  try { response=await fetcher('https://api.openrouteservice.org/v2/directions/driving-car/geojson',{method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(14000)}); }
  catch {throw new MobilityError(502,'Driving provider is unavailable. Retry later.');}
  if(response.status===429)throw new MobilityError(429,'Driving API quota reached. Wait before retrying.');
  if(response.status===401||response.status===403)throw new MobilityError(503,'Driving API key is missing or not authorized. Staff should check ORS_API_KEY.');
  if(!response.ok) { if(response.status>=500)throw new MobilityError(502,'Driving provider is unavailable.'); return null; }
  let data;try{data=await response.json();}catch{throw new MobilityError(502,'Invalid driving provider response.');}
  const feature=data?.features?.[0],coords=feature?.geometry?.coordinates,summary=feature?.properties?.summary;
  if(feature?.geometry?.type!=='LineString'||!Array.isArray(coords)||coords.length<2||coords.length>30000||coords.some(p=>!Array.isArray(p)||p.length<2||!p.slice(0,2).every(Number.isFinite))||!Number.isFinite(summary?.duration)||summary.duration<0||summary.duration>21600||!Number.isFinite(summary.distance)||summary.distance<0)
    throw new MobilityError(502,'Invalid driving route geometry.');
  return feature;
}

export async function drivingRoute(context,body,when,rules,closures,env,fetcher=fetch) {
  if(!env.ORS_API_KEY)throw new MobilityError(503,'Driving needs an openrouteservice API key. Staff: run npm run secret:routing, then npm run deploy.');
  if(!env.DB)throw new MobilityError(503,'Connect D1 before using driving routes and live gate restrictions.');
  if(!footballContext(context.footballData,when).known_season)throw new MobilityError(503,'Football schedule for this year is not registered. Staff must update the schedule before driving routes are offered.');
  const credentials={usc_id:body.usc_id===true,parking_pass:body.parking_pass===true,reservation:body.reservation===true};
  const origin=body.from;if(!origin||!Number.isFinite(origin.lat)||!Number.isFinite(origin.lon)||Math.abs(origin.lat)>90||Math.abs(origin.lon)>180)throw new MobilityError(400,'Driving requires a numeric GPS/map origin.');
  if(haversine(ll(origin),[34.021,-118.285])>90000)throw new MobilityError(400,'Driving preview supports starts within 90 km of USC.');
  const building=context.router.findBuilding(body.to);
  if(!building)throw new Unreachable('Choose a specific destination building.',[],context.router.candidates(body.to).map(b=>({id:b.id,name:b.name})));
  const parking=parkingState(context,when,rules,credentials);
  if(body.parking&&body.parking!=='auto'&&!parking.some(p=>p.id===body.parking))throw new MobilityError(400,'Unknown parking structure.');
  const walking=forMode(closures,'walking'),driving=forMode(closures,'driving').filter(c=>c.status==='approved');
  const candidates=[];
  for(const p of parking.filter(p=>p.eligible&&(!body.parking||body.parking==='auto'||p.id===body.parking))) {
    const score=haversine(ll(p.exit_node),[building.lat,building.lon])/81+haversine(ll(origin),ll(p.entrance))/500;
    candidates.push({p,score});
  }
  candidates.sort((a,b)=>a.score-b.score);
  if(!candidates.length)return {ok:false,reason:'No eligible parking route. Check gate hours, access requirements, or choose another structure.',parking};
  const reportAreas=driving.map(c=>({id:c.id,name:c.note||'Approved blockage',basis:'staff_confirmed',geometry:circlePolygon(c.lat,c.lon,c.radius_m||15)}));
  let attempts=0;
  // A bounded number of requests protects the free-tier quota; choose a specific
  // structure to try one outside this shortlist. This is not global optimization.
  for(const {p} of candidates.slice(0,2)) {
    const gate=gateState(context,when,rules,credentials).find(g=>g.id===p.gate);
    const via=gate.lat!==undefined?{lat:gate.lat,lon:gate.lon}:p.entrance;
    const coordinates=[xy(origin)];
    if(haversine(ll(origin),ll(via))>30&&haversine(ll(via),ll(p.entrance))>30)coordinates.push(xy(via));
    coordinates.push(xy(p.entrance));
    // Start with a conservative horizon; recheck the exact resulting arrival.
    const horizon=when+Math.max(1800000,haversine(ll(origin),ll(p.entrance))/5*1000);
    const areas=[...avoidance(context,when,horizon,rules,credentials),...reportAreas];
    if(areas.some(a=>intersectsPolygon([xy(origin)],a.geometry)||intersectsPolygon([xy(p.entrance)],a.geometry)))continue;
    attempts++;
    const feature=await directions(coordinates,areas,env.ORS_API_KEY,fetcher,env.DB);if(!feature)continue;
    const coords=feature.geometry.coordinates,duration=feature.properties.summary.duration,arrival=when+duration*1000;
    const actual=[...avoidance(context,when,arrival,rules,credentials),...reportAreas];
    if(actual.some(a=>intersectsPolygon(coords,a.geometry)))continue;
    if(haversine([coords[0][1],coords[0][0]],ll(origin))>30||haversine([coords.at(-1)[1],coords.at(-1)[0]],ll(p.entrance))>30)continue;
    if(coordinates.length===3&&!coords.some(c=>haversine([c[1],c[0]],ll(via))<=35))continue;
    if(!parkingState(context,arrival,rules,credentials).find(row=>row.id===p.id)?.eligible)continue;
    // Check every mapped gate touched by the polyline at the approximate crossing
    // time, as well as departure/arrival. A route is discarded on any violation.
    let cumulative=0;const distances=coords.slice(1).map((c,i)=>haversine([coords[i][1],coords[i][0]],[c[1],c[0]])),total=distances.reduce((a,b)=>a+b,0)||1;
    let invalid=false;
    const mappedGates=gateState(context,when,rules,credentials).filter(g=>g.lat!==undefined);
    for(let i=1;i<coords.length;i++) {
      for(const g of mappedGates) {
        if(pointSegment(ll(g),[coords[i-1][1],coords[i-1][0]],[coords[i][1],coords[i][0]])<=25) {
          for(const fraction of [cumulative/total,(cumulative+distances[i-1])/total])
            if(!gateState(context,when+duration*1000*fraction,rules,credentials).find(row=>row.id===g.id)?.eligible)invalid=true;
        }
      }
      cumulative+=distances[i-1];
    }
    if(invalid)continue;
    // Revalidate the walking continuation at arrival, not at departure.
    let arrivalWalk;
    try{arrivalWalk=context.router.route({building:building.id,place:p.id,exit:p.exit,stepFree:body.step_free===true,
      closures:walking.filter(c=>c.status==='approved'&&context.time.parseTime(c.starts)<=arrival&&arrival<context.time.parseTime(c.ends)),
      reports:walking.filter(c=>c.status==='unverified')});}
    catch(error){if(error instanceof Unreachable)continue;throw error;}
    return {ok:true,type:'FeatureCollection',mode:'driving',features:[{...feature,properties:{...feature.properties,kind:'route',mode:'driving'}},
      point(xy(via),{kind:'gate',name:gate.name}),point(xy(p.entrance),{kind:'parking',name:p.name})],
      summary:{minutes:Math.round(duration/6)/10,metres:Math.round(feature.properties.summary.distance),walking_minutes:arrivalWalk.summary.minutes,
        building:building.id,building_name:building.name,parking:p,gate,arrival:context.time.campusISO(arrival),storage:'d1',
        avoided:actual.map(a=>({id:a.id,name:a.name,basis:a.basis})),provider:'openrouteservice',live_traffic:false,
        gate_locations_note:context.mobilityData.gate_locations_note,selection:'First valid candidate among at most two ranked parking options; not a guaranteed fastest route.',provider_requests:attempts},
      steps:(feature.properties.segments||[]).flatMap(s=>s.steps||[]).map(s=>({instruction:s.instruction,distance:s.distance,duration:s.duration})),
      walking_preview:arrivalWalk,handoff:{action:'parked',parking:p.id,exit:p.exit,lat:p.exit?context.survey.nodes.find(n=>n.id===p.exit).lat:null,
        lon:p.exit?context.survey.nodes.find(n=>n.id===p.exit).lon:null,building:building.id},
      attribution:'© openrouteservice.org by HeiGIT | © OpenStreetMap contributors (ODbL)'};
  }
  return {ok:false,reason:'No route passed the gate and closure checks. Try another parking structure or wait for staff access updates.',provider_requests:attempts,parking};
}
