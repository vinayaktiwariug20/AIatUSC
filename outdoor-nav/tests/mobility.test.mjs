import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {WalkRouter, haversine} from '../cloudflare/router.mjs';
import {parseTime,campusISO,gateStatus,handleApi} from '../cloudflare/api.mjs';
import {gateState,parkingState,footballContext,avoidance,intersectsPolygon,drivingRoute,wayIn,aroundCampus,cutLoop,UNMAPPED_LEG_M,validateRule,readRules,circlePolygon,GATE_AVOID_RADIUS_M,walkingRuleClosures,DIRECTIONS_LIMITS}from '../cloudflare/mobility.mjs';
import {collectFacts} from '../cloudflare/assistant.mjs';
const json=name=>JSON.parse(readFileSync(new URL('../'+name,import.meta.url),'utf8'));
const context={router:new WalkRouter(json('cloudflare/graph.json')),gateData:json('data/gates.json'),mobilityData:json('data/mobility.json'),footballData:json('data/football.json'),survey:json('data/surveyed.json'),time:{parseTime,campusISO,gateStatus}};
class D1{constructor(){this.db=new DatabaseSync(':memory:');for(const f of ['0001_closures.sql','0002_mobility.sql'])this.db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));}prepare(sql){let params=[];const db=this.db;return{bind(...values){params=values;return this;},async first(column){const row=db.prepare(sql).get(...params);return row?column?row[column]:row:null;},async run(){return db.prepare(sql).run(...params);}};}}
const monday=parseTime('2026-11-16T12:00:00'),saturday=parseTime('2026-11-14T12:00:00');
const body={mode:'driving',from:{lat:34.027,lon:-118.2871694},to:'Doheny',parking:'downey'};
const env=()=>({DB:new D1(),ORS_API_KEY:'private-test-key',ADMIN_TOKEN:'staff',PUBLIC_REPORTS_ENABLED:'true'});
function provider(transform=coords=>coords,status=200){const calls=[];const fn=async(url,options)=>{const data=JSON.parse(options.body);calls.push({url,body:data,headers:options.headers});return new Response(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:transform(data.coordinates)},properties:{summary:{duration:240,distance:1200},segments:[{steps:[{instruction:'Continue on McClintock',distance:1200,duration:240}]}]}}]}),{status});};return{fn,calls};}
async function api(e,path,method='GET',body,token){const r=await handleApi(new Request('https://app.test'+path,{method,headers:{'Content-Type':'application/json',...(token?{'X-Admin-Token':token}:{})},body:body===undefined?undefined:JSON.stringify(body)}),e,context);return{status:r.status,data:await r.json()};}

test('weekday, weekend, USC-ID and reservation eligibility are separate',()=>{
 const weekday=gateState(context,monday),weekend=gateState(context,saturday);
 assert.equal(weekday.find(g=>g.id==='watt').eligible,true);assert.equal(weekend.find(g=>g.id==='watt').eligible,false);
 assert.equal(weekend.find(g=>g.id==='mcclintock').eligible,true);
 assert.equal(weekday.find(g=>g.id==='pardee'),undefined);               // removed: special access only (VIPs, unloading)
 assert.equal(weekend.find(g=>g.id==='flower').eligible,false);
 assert.equal(gateState(context,saturday,[],{usc_id:true}).find(g=>g.id==='flower').eligible,true);
});
test('home games activate precautionary avoidance; away games do not',()=>{
 assert.equal(footballContext(context.footballData,saturday).game,null);
 const game=parseTime('2026-11-21T09:00:00');assert.equal(footballContext(context.footballData,game).game.opponent,'Maryland');
 assert.ok(avoidance(context,game,game+1,[],{}).some(a=>a.basis==='precaution_not_confirmed'));
 assert.equal(avoidance(context,saturday,saturday+1,[],{}).some(a=>a.basis==='precaution_not_confirmed'),false);
 assert.equal(footballContext(context.footballData,parseTime('2027-01-01T09:00')).known_season,true);    // off-season: no home games
 assert.equal(footballContext(context.footballData,parseTime('2027-07-31T23:00')).known_season,true);
 assert.equal(footballContext(context.footballData,parseTime('2027-08-01T09:00')).known_season,false);   // next season's schedule needed
});
test('a trip crossing midnight into a home-game date activates precautions',()=>{
 const t=parseTime('2026-11-20T23:55:00');assert.ok(avoidance(context,t,t+600000,[],{}).some(a=>a.id.startsWith('precaution:')));
});
test('game parking never treats an ID as a prepaid parking pass',()=>{
 const when=parseTime('2026-11-21T10:00:00');const ps=parkingState(context,when,[],{usc_id:true});
 assert.equal(ps.find(p=>p.id==='jefferson').eligible,false);
 assert.equal(ps.find(p=>p.id==='royal').eligible,false);
 assert.equal(ps.find(p=>p.id==='downey').eligible,true);
});
test('segment crossing is detected even when neither vertex lies inside the polygon',()=>{
 const poly={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]};
 assert.equal(intersectsPolygon([[-1,.5],[2,.5]],poly),true);
 assert.equal(intersectsPolygon([[.5,.5],[.7,.7]],poly),true);
 assert.equal(intersectsPolygon([[-1,2],[2,2]],poly),false);
 assert.equal(intersectsPolygon([[-1,0],[2,0]],poly),true);
});
test('a valid driving route drives to the open gate, then the campus leg to the structure, and previews the walk',async()=>{
 // Saturday: the Downey Way gate is closed, so Downey is entered through McClintock.
 const e=env(),mock=provider(),out=await drivingRoute(context,body,parseTime('2026-11-14T18:00'),[],[],e,mock.fn);
 assert.equal(out.ok,true);assert.equal(out.mode,'driving');assert.equal(out.summary.parking.id,'downey');assert.equal(out.summary.live_traffic,false);
 assert.equal(out.handoff.exit,'DOWNEY.ped.main');assert.equal(out.walking_preview.summary.start_place.exit,'DOWNEY.ped.main');
 // the provider is asked to reach the GATE (McClintock: the middle of the intersection), never to drive campus roads
 assert.equal(mock.calls.length,1);assert.equal(mock.calls[0].body.coordinates.length,2);
 assert.deepEqual(mock.calls[0].body.coordinates.at(-1),[-118.2870874,34.0251038]);
 // campus leg: gate -> surveyed McClintock/Downey Way intersection -> structure entrance
 const leg=out.features.find(f=>f.properties.kind==='campus');assert.ok(leg);
 assert.deepEqual(leg.geometry.coordinates.at(-1),[-118.28997731807364,34.02077789075529]);
 assert.ok(out.summary.campus_m>500&&out.summary.campus_m<600,out.summary.campus_m);
 assert.match(out.steps.at(-1).instruction,/Enter campus at McClintock/);
 assert.equal(mock.calls[0].headers.Authorization,'private-test-key');assert.equal(JSON.stringify(out).includes('private-test-key'),false);
 const walk=await api(e,'/api/outdoor/route','POST',{from:{place:out.handoff.parking,exit:out.handoff.exit},to:out.handoff.building,mode:'walking',at:'2026-11-16T12:05:00'});
 assert.equal(walk.data.ok,true);assert.equal(walk.data.summary.start_place.exit,'DOWNEY.ped.main');
});

test('a provider route passing a closed gate is discarded even if the provider ignored avoidance',async()=>{
 const mock=provider(coords=>[...coords.slice(0,-1),[-118.2889172,34.0184081],coords.at(-1)]);
 const out=await drivingRoute(context,body,saturday,[],[],env(),mock.fn);
 assert.equal(out.ok,false);assert.equal(mock.calls.length,1);
 assert.ok(mock.calls[0].body.options.avoid_polygons.coordinates.length);
});
// Live bug: asked to continue past the gate to the structure, the provider
// touched the gate, turned back and parked on the nearest public street. The
// route must END at the gate; anything that stops elsewhere is rejected.
test('a provider route that does not end at the planned gate is rejected',async()=>{
 for(const transform of [coords=>[...coords.slice(0,-1),[-118.30,34.02]],coords=>[...coords.slice(0,-1),[-118.2899,34.0221]]]){
  const out=await drivingRoute(context,body,monday,[],[],env(),provider(transform).fn);assert.equal(out.ok,false);
  assert.ok(out.checks.some(c=>c.check==='route does not reach the gate'),JSON.stringify(out.checks));
 }
});

test('staff gate closures apply only during their exact interval',()=>{
 const rule=validateRule({kind:'gate',gate:'mcclintock',starts:'2026-11-16T12:00',ends:'2026-11-16T13:00'},context);
 assert.equal(gateState(context,monday-1,[rule]).find(g=>g.id==='mcclintock').eligible,true);
 assert.equal(gateState(context,monday,[rule]).find(g=>g.id==='mcclintock').eligible,false);
 assert.equal(gateState(context,monday+3600000,[rule]).find(g=>g.id==='mcclintock').eligible,true);
});
test('scheduled road closures overlapping the trip are enforced before their start time',async()=>{
 const geometry=circlePolygon(34.0250085,-118.2871694,30);
 const rule=validateRule({kind:'road',geometry,starts:'2026-11-16T12:01',ends:'2026-11-16T13:00'},context);
 // A road closure at McClintock overlapping the trip: Downey is entered via Downey Way instead.
 const out=await drivingRoute(context,body,monday,[rule],[],env(),provider().fn);assert.equal(out.ok,true);assert.equal(out.summary.gate.id,'downey-way');
 // On a Saturday (Downey Way closed) there is no other way in, so it is refused.
 const sat={...rule,starts_ms:parseTime('2026-11-14T17:01'),ends_ms:parseTime('2026-11-14T19:00')};
 assert.equal((await drivingRoute(context,body,parseTime('2026-11-14T18:00'),[sat],[],env(),provider().fn)).ok,false);
});
test('a gate closing before arrival cannot be recommended',async()=>{
 const at=parseTime('2026-11-14T15:29:00'),out=await drivingRoute(context,{...body,parking:'jefferson'},at,[],[],env(),provider().fn);
 assert.equal(out.ok,false);
});
test('walking-only reports do not block vehicle routing',async()=>{
 const closure={id:'ped',lat:34.0250085,lon:-118.2871694,radius_m:30,status:'approved',starts:'2026-11-16T10:00',ends:'2026-11-16T14:00',modes:['walking']};
 const out=await drivingRoute(context,body,monday,[],[closure],env(),provider().fn);assert.equal(out.ok,true);
 const car=await drivingRoute(context,body,monday,[],[{...closure,modes:['driving']}],env(),provider().fn);assert.equal(car.ok,true);assert.equal(car.summary.gate.id,'downey-way');
});
test('missing key, missing D1 and out-of-range starts fail explicitly; provider quota hands off to a maps app',async()=>{
 await assert.rejects(()=>drivingRoute(context,body,monday,[],[],{DB:new D1()},provider().fn),e=>e.status===503);
 await assert.rejects(()=>drivingRoute(context,body,monday,[],[],{ORS_API_KEY:'key'},provider().fn),e=>e.status===503);
 await assert.rejects(()=>drivingRoute(context,{...body,from:{lat:0,lon:0}},monday,[],[],env(),provider().fn),e=>e.status===400);
 // openrouteservice says 429: no error, a plan for the phone's maps app instead
 const busy=await drivingRoute(context,body,monday,[],[],env(),provider(undefined,429).fn);
 assert.equal(busy.ok,true);assert.equal(busy.handoff_only,true);assert.equal(busy.why,'busy');
 assert.ok(Number.isFinite(busy.summary.drive_to.lat));assert.ok(busy.walking_preview.summary.minutes>0);
});
test('global quota counts upstream requests; when it is used up, no provider call and a maps-app plan',async()=>{
 // Caps stay at or under openrouteservice's free plan even across a minute/day boundary (40/min sliding, 2,000/day).
 assert.ok(DIRECTIONS_LIMITS.minute*2<=40&&DIRECTIONS_LIMITS.day*2<=2000);
 const e=env(),slot='minute:'+Math.floor(Date.now()/60000);e.DB.db.prepare('INSERT INTO routing_usage VALUES(?,?,?)').run(slot,DIRECTIONS_LIMITS.minute-1,Date.now()+120000);
 // one request left this minute: it is used, then the next search gets the maps-app plan without calling the provider
 const first=provider();assert.equal((await drivingRoute(context,body,monday,[],[],e,first.fn)).ok,true);assert.equal(first.calls.length,1);
 const mock=provider();const out=await drivingRoute(context,body,monday,[],[],e,mock.fn);assert.equal(out.handoff_only,true);assert.equal(mock.calls.length,0);
});
test('openrouteservice 403 for a used-up daily quota falls back to the maps-app plan; a bad key is still an error',async()=>{
 const quota=async()=>new Response(JSON.stringify({error:'Quota exceeded'}),{status:403});
 const out=await drivingRoute(context,body,monday,[],[],env(),quota);
 assert.equal(out.handoff_only,true);assert.equal(out.why,'busy');
 const badKey=async()=>new Response(JSON.stringify({error:'Access to this API has been disallowed'}),{status:403});
 await assert.rejects(()=>drivingRoute(context,body,monday,[],[],env(),badKey),e=>e.status===503);
});
test('gate and road changes require admin authorization and persist in real SQL',async()=>{
 const e=env(),b={kind:'gate',gate:'watt',starts:'2026-11-16T10:00',ends:'2026-11-16T14:00',note:'staff traffic control'};
 assert.equal((await api(e,'/api/mobility/rules','POST',b)).status,403);
 const saved=await api(e,'/api/mobility/rules','POST',b,'staff');assert.equal(saved.status,201);
 const rows=await readRules(e.DB,monday);assert.equal(rows[0].gate,'watt');
 const state=await api(e,'/api/mobility?at=2026-11-16T12:00');assert.equal(state.data.gates.find(g=>g.id==='watt').basis,'staff_confirmed');
 assert.equal((await api(e,'/api/mobility/rules/'+saved.data.id,'DELETE',undefined,'staff')).status,200);assert.deepEqual(await readRules(e.DB,monday),[]);
});
test('invalid, degenerate or self-crossing road polygons cannot reach the routing provider',()=>{
 for(const ring of [[[0,0],[1,0],[1,1],[0,0]],[[-118.29,34.02],[-118.28,34.02],[-118.27,34.02],[-118.29,34.02]],[[-118.29,34.02],[-118.28,34.03],[-118.29,34.03],[-118.28,34.02],[-118.29,34.02]]])assert.throws(()=>validateRule({kind:'road',geometry:{type:'Polygon',coordinates:[ring]}},context));
});
test('public reporting is enabled by the deployment config and stays unverified',async()=>{
 const conf=json('wrangler.jsonc');assert.equal(conf.vars.PUBLIC_REPORTS_ENABLED,'true');
 const out=await api(env(),'/api/closures','POST',{lat:34.02,lon:-118.287,modes:['walking','driving']});assert.equal(out.status,201);assert.equal(out.data.status,'unverified');assert.deepEqual(out.data.modes,['walking','driving']);
});

test('a backlog of unverified public reports cannot disable walking routes',async()=>{
 const e=env();for(let n=0;n<110;n++)e.DB.db.prepare('INSERT INTO closures VALUES(?,?,?,?,?,?)').run('public'+n,'unverified',monday-60000,monday+3600000,monday+n,JSON.stringify({id:'public'+n,status:'unverified',lat:34.02,lon:-118.287,radius_m:15,starts:campusISO(monday-60000),ends:campusISO(monday+3600000)}));
 const out=await api(e,'/api/outdoor/route','POST',{from:{lat:34.0187,lon:-118.2905},to:'Doheny',at:campusISO(monday)});assert.equal(out.data.ok,true);
 const reports=await api(e,'/api/closures?at='+encodeURIComponent(campusISO(monday)));assert.equal(reports.data.length,20);
});
// The user is usually standing off the road (a building, a park, a lot). A route
// may start up to START_TO_ROAD_LIMIT_M away, drawn as a dotted connector; the END
// must still reach the parking entrance. (Live bug: every route from a point 41 m
// off the road was discarded by an old 30 m start check.)
test('a driving route may start up to 300 m from the user, with a dotted connector',async()=>{
 const off=coords=>[[coords[0][0],coords[0][1]+0.00108],...coords.slice(1)];      // ~120 m north of the user
 const out=await drivingRoute(context,body,monday,[],[],env(),provider(off).fn);
 assert.equal(out.ok,true);assert.ok(Math.abs(out.summary.start_to_road_m-120)<5,out.summary.start_to_road_m);
 const c=out.features.find(f=>f.properties.kind==='to_road');assert.ok(c);assert.deepEqual(c.geometry.coordinates[0],[body.from.lon,body.from.lat]);
});
test('a driving route starting farther than the limit from the user is still rejected',async()=>{
 const far=coords=>[[coords[0][0],coords[0][1]+0.0036],...coords.slice(1)];       // ~400 m away
 const out=await drivingRoute(context,body,monday,[],[],env(),provider(far).fn);
 assert.equal(out.ok,false);
});
// Live bug: on evenings/weekends no driving route survived, because closed gates
// with APPROXIMATE pins (middle of public intersections) became 35 m no-go
// circles that closed the public streets around campus.
// Every gate is pinned now; this one is put back on an intersection guess to keep the rule tested.
const approxContext={...context,mobilityData:{...context.mobilityData,gates:context.mobilityData.gates.map(g=>g.id==='jefferson-blvd'?{id:g.id,lat:34.02488,lon:-118.29026,location_source:'approximate_intersection'}:g)}};
test('closed gates with approximate pins do not close public streets; surveyed gates get a small circle',async()=>{
 const sat=parseTime('2026-11-14T20:00:00'),areas=avoidance(context,sat,sat+1800000,[],{});
 const ids=areas.map(a=>a.id);
 assert.ok(!avoidance(approxContext,sat,sat+1800000,[],{}).some(a=>a.id==='gate:jefferson-blvd'));   // approximate pin
 assert.ok(ids.includes('gate:watt'),ids);                                  // surveyed, closed on weekends
 assert.ok(ids.includes('gate:downey-way'),ids);                            // pinned on 36th Pl, closed to cars on weekends
 // Jefferson is pinned 12.5 m from Jefferson Blvd (at about 34.02545): its circle sits inside campus too.
const jeff=areas.find(a=>a.id==='gate:jefferson-blvd');assert.ok(jeff,ids);
 for(const [lon,lat] of jeff.geometry.coordinates[0])assert.ok(lat<34.0254,'circle reaches Jefferson: '+lat);
 // Royal is pinned 12 m from Jefferson: its circle sits inside campus and stays clear of the street.
 const royal=areas.find(a=>a.id==='gate:royal');assert.ok(royal);
 for(const [lon,lat] of royal.geometry.coordinates[0])assert.ok(lat<34.02285,'circle reaches Jefferson: '+lat);
 const watt=areas.find(a=>a.id==='gate:watt').geometry.coordinates[0][0];   // a ring point
 const r=haversine([watt[1],watt[0]],[34.0184081,-118.2889172]);assert.ok(r<=GATE_AVOID_RADIUS_M+1,r);
});
test('driving along Vermont past the closed Downey Way gate is not a rejection',async()=>{
 const past=coords=>[coords[0],[-118.29145,34.02149],...coords.slice(1)];  // Vermont at 36th Pl, about 50 m from the gate pin
 const out=await drivingRoute(context,body,parseTime('2026-11-14T20:00:00'),[],[],env(),provider(past).fn);
 assert.equal(out.ok,true,JSON.stringify(out.checks));
});
test('a failed driving search says which check rejected each candidate',async()=>{
 const out=await drivingRoute(context,body,monday,[],[],env(),provider(c=>c,404).fn);
 assert.equal(out.ok,false);assert.ok(out.checks.length>=1);assert.equal(out.checks[0].check,'provider returned no route');assert.equal(out.checks[0].status,404);
});
// Live: openrouteservice refused with "Could not find routable point within a radius
// of 25.0 meters of specified coordinate 0" -- the off-road start.
test('driving request gives the start a wide road-search radius and the gate a tight one',async()=>{
 const mock=provider(),out=await drivingRoute(context,body,parseTime('2026-11-14T18:00'),[],[],env(),mock.fn);
 assert.equal(out.ok,true);
 const r=mock.calls[0].body.radiuses;assert.deepEqual(r,[300,30]);           // McClintock pin is surveyed
});


test('rule modes: default cars; walking needs a surveyed gate pin; bad modes rejected',()=>{
 const base={kind:'gate',gate:'mcclintock',starts:'2026-11-16T12:00',ends:'2026-11-16T13:00'};
 assert.deepEqual(validateRule(base,context).modes,['driving']);
 assert.deepEqual(validateRule({...base,modes:['walking','driving']},context).modes,['walking','driving']);
 assert.throws(()=>validateRule({...base,modes:['flying']},context),/Closed to/);
 assert.throws(()=>validateRule({...base,gate:'jefferson-blvd',modes:['walking']},approxContext),/approximate/);
 assert.deepEqual(validateRule({...base,gate:'downey-way',modes:['walking']},context).modes,['walking']);   // now pinned
});
test('a walking-only gate closure leaves car access alone; a cars-only one leaves walking alone',()=>{
 const when=parseTime('2026-11-16T12:30'),walk={...validateRule({kind:'gate',gate:'mcclintock',starts:'2026-11-16T12:00',ends:'2026-11-16T13:00',modes:['walking']},context)};
 assert.equal(gateState(context,when,[walk]).find(g=>g.id==='mcclintock').vehicle.status!=='closed',true);
 assert.equal(walkingRuleClosures(context,[walk],when).length,1);
 const cars=validateRule({kind:'gate',gate:'mcclintock',starts:'2026-11-16T12:00',ends:'2026-11-16T13:00'},context);
 assert.equal(walkingRuleClosures(context,[cars],when).length,0);
});
test('a walking-only AREA makes walking routes go round it, and is not a driving no-go area',async()=>{
 const e=env(),at='2026-11-16T12:30:00',from={lat:34.02065,lon:-118.2872};
 const plain=(await api(e,'/api/outdoor/route','POST',{from,to:'Doheny',at})).data;
 const line=plain.features[0].geometry.coordinates,[x,y]=line[Math.floor(line.length/2)],d=0.00015;
 const ring=[[x-d,y-d],[x+d,y-d],[x+d,y+d],[x-d,y+d],[x-d,y-d]];
 const rule=(await api(e,'/api/mobility/rules','POST',{kind:'road',modes:['walking'],starts:'2026-11-16T12:00',ends:'2026-11-16T14:00',note:'Stage build',geometry:{type:'Polygon',coordinates:[ring]}},'staff')).data;
 assert.deepEqual(rule.modes,['walking']);
 const after=(await api(e,'/api/outdoor/route','POST',{from,to:'Doheny',at})).data;
 assert.equal(after.ok,true);
 assert.ok(after.summary.avoided.some(a=>a.closure==='rule:'+rule.id),JSON.stringify(after.summary.avoided));
 assert.ok(!avoidance(context,parseTime(at),parseTime(at)+1800000,[rule]).some(a=>a.id===rule.id));
});
// Permits, as described by people who park at USC: a permit always lets its holder park in
// its own structure; on weekends a permit for any structure is valid at every structure.
// A permit never overrides a closure that staff confirmed.
test('a parking permit opens its own structure when the public cannot use it',()=>{
 const night=parseTime('2026-11-16T22:00:00');   // Monday: the Jefferson Blvd. gate's public hours end at 20:00 (and it reaches only its structure)
 const jeff=c=>parkingState(context,night,[],c).find(p=>p.id==='jefferson');
 assert.equal(jeff({}).eligible,false);
 const mine=jeff({permit:'jefferson'});assert.equal(mine.eligible,true);assert.equal(mine.permit_access,true);
 assert.equal(gateState(context,night,[],{permit:'jefferson'}).find(g=>g.id==='jefferson-blvd').permit_access,true);
 // A weekday permit for another structure does not help, and an unknown value is ignored.
 assert.equal(jeff({permit:'downey'}).eligible,false);assert.equal(jeff({permit:'nope'}).eligible,false);
 // It only opens the gate of the structure it covers.
 assert.equal(gateState(context,night,[],{permit:'jefferson'}).find(g=>g.id==='watt').eligible,false);
});
test('on weekends a permit for any structure is valid at every structure; not on weekdays',()=>{
 const sat=parseTime('2026-11-14T20:00:00');     // Saturday evening: the Jefferson gate is closed to the public
 const state=c=>Object.fromEntries(parkingState(context,sat,[],c).map(p=>[p.id,p.eligible]));
 assert.equal(state({}).jefferson,false);
 const withPermit=state({permit:'downey'});
 for(const id of ['downey','jefferson','royal','mccarthy','figueroa'])assert.equal(withPermit[id],true,id);
 const weekday=parseTime('2026-11-16T22:00:00');
 assert.equal(parkingState(context,weekday,[],{permit:'downey'}).find(p=>p.id==='jefferson').eligible,false);
});
test('a permit also covers game-day restrictions, but never a staff-confirmed gate closure',()=>{
 const game=parseTime('2026-11-21T10:00:00');    // home game (a Saturday)
 assert.equal(parkingState(context,game,[],{}).find(p=>p.id==='jefferson').eligible,false);
 assert.equal(parkingState(context,game,[],{permit:'jefferson'}).find(p=>p.id==='jefferson').eligible,true);
 const rule={id:'r1',kind:'gate',gate:'jefferson-blvd',modes:['driving'],starts_ms:game-3600000,ends_ms:game+3600000,note:'Closed for the game'};
 const shut=parkingState(context,game,[rule],{permit:'jefferson'}).find(p=>p.id==='jefferson');
 assert.equal(shut.eligible,false);assert.match(shut.reason,/staff/i);
 assert.equal(gateState(context,game,[rule],{permit:'jefferson'}).find(g=>g.id==='jefferson-blvd').eligible,false);
});
test('Royal, Downey and Lot 2 can be reached through any of the connected campus entrances',()=>{
 const night=parseTime('2026-11-16T22:00:00');   // Royal's own gate is closed; McClintock is open 24 hours
 const royal=parkingState(context,night,[],{}).find(p=>p.id==='royal');
 assert.equal(royal.eligible,true);assert.equal(royal.gate,'mcclintock');
 assert.deepEqual(royal.access.map(a=>a.gate).sort(),['downey-way','mcclintock','royal','watt']);
 for(const id of ['jefferson','mccarthy'])assert.equal(parkingState(context,night,[],{}).find(p=>p.id===id).access.length,1,id);
});
test('a driving route uses the permit, and an unknown permit is rejected',async()=>{
 const sat=parseTime('2026-11-14T20:00:00'),request={...body,parking:'jefferson'};
 assert.equal((await drivingRoute(context,request,sat,[],[],env(),provider().fn)).ok,false);
 const out=await drivingRoute(context,{...request,permit:'downey'},sat,[],[],env(),provider().fn);
 assert.equal(out.ok,true,JSON.stringify(out.checks));assert.equal(out.summary.parking.id,'jefferson');assert.equal(out.summary.parking.permit_access,true);
 await assert.rejects(()=>drivingRoute(context,{...request,permit:'nope'},sat,[],[],env(),provider().fn),e=>e.status===400);
 const state=await api(env(),'/api/mobility?at=2026-11-14T20:00&permit=downey');
 assert.equal(state.data.parking.find(p=>p.id==='jefferson').eligible,true);
});
// Official three-letter building codes (USC FPM base map), so "JFF" or "HOH" finds the building.
test('official USC building codes find their buildings',()=>{
 const find=t=>context.router.findBuilding(t)?.name;
 assert.equal(find('JFF'),'Jill & Frank Fertitta Hall');assert.equal(find('jff'),'Jill & Frank Fertitta Hall');
 assert.equal(find('HOH'),'Hoffman Hall');assert.equal(find('DML'),'Edward L Doheny Junior Memorial Library');
 assert.equal(find('DMC'),'Dr. Joseph Medicine Crow Center for International and Public Affairs');
 assert.equal(find('JMC'),'John Mckay Center');            // official code; DMC is the Medicine Crow Center
 assert.equal(find('TCC'),'Ronald Tutor Campus Center');
 // No code may point at two buildings.
 const seen=new Map();
 for(const b of Object.values(context.router.data.buildings))for(const a of b.aliases||[])if(/^[A-Z]{2,4}$/.test(a)){assert.ok(!seen.has(a)||seen.get(a)===b.id,a+' is used twice');seen.set(a,b.id);}
});
// Reported Monday 15:26: the route went round to McClintock although the Downey Way
// gate (Vermont at 36th Pl) was open. Downey now has two ways in, and the faster wins.
test('Downey: through the Downey Way gate when it is open, McClintock when it is not',async()=>{
 const west={...body,from:{lat:34.0185,lon:-118.3003}};                    // Normandie / 37th Pl
 const mon=await drivingRoute(context,west,parseTime('2026-11-16T15:26'),[],[],env(),provider().fn);
 assert.equal(mon.ok,true);assert.equal(mon.summary.gate.id,'downey-way');
 assert.deepEqual(mon.features.find(f=>f.properties.kind==='campus').geometry.coordinates.at(-1),[-118.29046687186089,34.02155085589507]);
 const sat=await drivingRoute(context,west,parseTime('2026-11-14T18:00'),[],[],env(),provider().fn);
 assert.equal(sat.ok,true);assert.equal(sat.summary.gate.id,'mcclintock');
 const night=await drivingRoute(context,west,parseTime('2026-11-16T21:00'),[],[],env(),provider().fn);
 assert.equal(night.summary.gate.id,'mcclintock');                          // Downey Way closes at 20:00
});
test('the faster way in is chosen door to door (drive + walk), not by drive time alone',async()=>{
 // Both candidates get the same provider drive time here; the walk decides.
 const west={...body,from:{lat:34.0185,lon:-118.3003},parking:'auto',to:'Dedeaux'};
 const out=await drivingRoute(context,west,parseTime('2026-11-16T21:00'),[],[],env(),provider().fn);
 assert.equal(out.ok,true);
 if(out.summary.provider_requests>1)assert.equal(out.summary.parking.id,'downey',JSON.stringify(out.summary.parking.id));
});
test("Shrine: the 32nd St entrance on weekdays 6-6, the Jefferson entrance (USC ID) otherwise",()=>{
 const at=(t,c={})=>parkingState(context,parseTime(t),[],c).find(p=>p.id==='shrine');
 assert.equal(at('2026-11-16T10:00:00').entrance.id,'SHRINE.veh.main');
 assert.equal(at('2026-11-16T20:00:00').eligible,false);                    // after hours, no ID
 assert.equal(at('2026-11-16T20:00:00',{usc_id:true}).entrance.id,'SHRINE.veh.jefferson');
 assert.equal(at('2026-11-14T12:00:00',{usc_id:true}).entrance.id,'SHRINE.veh.jefferson');   // Saturday
});
test('the DCC-PSD gate: kept locked on foot (seen), never a no-drive area',()=>{
 const sat=parseTime('2026-11-14T12:00:00'),wed=parseTime('2026-11-18T12:00:00');
 const g=t=>gateState(context,t,[],{}).find(x=>x.id==='dcc-psd');
 assert.equal(g(wed).pedestrian.status,'closed');assert.equal(g(wed).pedestrian.locked,true);   // seen locked inside its scheduled hours
 assert.equal(g(wed).pedestrian_only,true);
 assert.ok(!avoidance(context,sat,sat+1800000,[],{}).some(a=>a.id==='gate:dcc-psd'));
});

test('a storage failure tells people what to do, not how to run migrations', async () => {
  const broken = {prepare(){ return {bind(){ return {first: async () => { throw new Error('no such table: mobility_rules'); }}; }}; }};
  const log = console.error; console.error = () => {};
  try { await assert.rejects(readRules(broken, Date.now()), e => e.status === 503 && /Try again in a minute/.test(e.message) && !/npm/.test(e.message)); }
  finally { console.error = log; }
});

test('a momentary storage failure is retried once', async () => {
  let calls = 0;
  const flaky = {prepare(sql){ return {bind(){ return {first: async () => {
    if (sql.includes('mobility_rules') && calls++ === 0) throw new Error('D1 hiccup');
    return '[]'; }}; }}; }};
  assert.deepEqual(await readRules(flaky, Date.now()), []);
  assert.equal(calls, 2);
});

// Downey's $20 daily rate: Mon-Thu from noon at the pay station, by phone too from 4 pm; all day Fri-Sun.
test('a published rate says when it goes on sale and how to pay at this hour',()=>{
 const downey=when=>parkingState(context,parseTime(when),[],{}).find(p=>p.id==='downey');
 const morning=downey('2026-11-24T10:00');                                   // a Tuesday
 assert.deepEqual(morning.rates,[]);
 assert.deepEqual(morning.rates_later,[{option:'daily',price:20,max:null,from:'12:00'}]);
 const noon=downey('2026-11-24T12:13');
 assert.equal(noon.rates[0].pay,'pay_station');assert.deepEqual(noon.rates[0].pay_from,{time:'16:00',pay:'phone_or_station'});
 assert.deepEqual(noon.rates_later,[]);
 const evening=downey('2026-11-24T17:00');
 assert.equal(evening.rates[0].pay,'phone_or_station');assert.equal(evening.rates[0].pay_from,undefined);
 const saturday=downey('2026-11-28T09:00');
 assert.equal(saturday.rates[0].pay,'phone_or_station');assert.equal(saturday.rates[0].pay_from,undefined);
 // A staff event price replaces everything, including what would start later.
 const event={id:'e',kind:'rate',parking:'downey',option:'event',price:45,starts_ms:parseTime('2026-11-24T00:00'),ends_ms:parseTime('2026-11-25T00:00'),created_ms:0,updated:'2026-11-24T00:00'};
 assert.deepEqual(parkingState(context,parseTime('2026-11-24T10:00'),[event],{}).find(p=>p.id==='downey').rates_later,[]);
});
test('the map words a rate in plain terms: when it starts, how to pay now, and who can park',()=>{
 const html=readFileSync(new URL('../outdoor/static/index.html',import.meta.url),'utf8');
 const code=html.slice(html.indexOf('function clock12('),html.indexOf('// Map labels: just the prices'));
 const ctx=vm.createContext({});vm.runInContext(code,ctx);
 assert.equal(vm.runInContext("clock12('12:00')+'|'+clock12('16:00')+'|'+clock12('09:30')+'|'+clock12('24:00')",ctx),'noon|4 pm|9:30 am|midnight');
 assert.equal(vm.runInContext("payWhen({pay:'pay_station',pay_from:{time:'16:00',pay:'phone_or_station'}})",ctx),' (pay station now; phone too from 4 pm)');
 assert.equal(vm.runInContext("payWhen({pay:'phone_or_station'})",ctx),'');
 assert.doesNotMatch(html,/[Aa]ccess requirements/);
});

// The Staff screen's "Booth sign" buttons post these exact bodies (index.html sgSave).
test('booth sign cards: Royal lists its cards, and each card saves as an ordinary staff update',async()=>{
 const royal=parkingState(context,parseTime('2026-11-24T12:00'),[],{}).find(p=>p.id==='royal');
 assert.deepEqual(royal.booth_signs.map(c=>c.sign+(c.price?c.price:'')),['event50','event40','event35','permits_only','full','available']);
 const e=env(),times={starts:'2026-11-24T12:00',ends:'2026-11-24T23:59'};
 for(const f of ['0003_questions.sql','0004_usage.sql','0005_parking_status.sql','0006_staff_keys.sql','0007_parking_rates.sql'])e.DB.db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const ev=await api(e,'/api/mobility/rules','POST',{kind:'rate',parking:'royal',option:'event',price:50,pay:'booth',label:'Event parking',...times,note:'Booth sign: EVENT PARKING $50'},'staff');
 assert.equal(ev.status,201,JSON.stringify(ev.data));
 const only=await api(e,'/api/mobility/rules','POST',{kind:'parking',parking:'royal',applies:'daily',status:'closed',spaces:null,...times,note:'Booth sign: PERMITS & RESERVATIONS ONLY'},'staff');
 assert.equal(only.status,201,JSON.stringify(only.data));
 const full=await api(e,'/api/mobility/rules','POST',{kind:'parking',parking:'royal',applies:'everyone',status:'full',spaces:null,...times,note:'Booth sign: LOT FULL'},'staff');
 assert.equal(full.status,201,JSON.stringify(full.data));
 const html=readFileSync(new URL('../outdoor/static/index.html',import.meta.url),'utf8');
 for(const s of ["kind:'rate',parking:p.id,option:'event',price:c.price,pay:'booth',label:'Event parking'","kind:'parking',parking:p.id,applies:c.sign==='full'?'everyone':'daily',status:c.sign==='full'?'full':'closed'"])assert.ok(html.includes(s),s);
});

// Anyone can write a public report's note; until staff approve it, only staff see it.
test('an unreviewed public report shows the public that it exists, not what it says; staff see the note',async()=>{
 const e=env(),route=async token=>(await api(e,'/api/outdoor/route','POST',{from:{lat:34.0205,lon:-118.2862},to:'Student Union'},token)).data;
 const line=(await route()).features.find(f=>f.properties.kind==='route').geometry.coordinates,[lon,lat]=line[Math.floor(line.length/2)];
 const made=await api(e,'/api/closures','POST',{lat,lon,note:'call 555-0100, gate locked by J. Smith',kind:'<b>anything</b>'});   // on the route
 assert.equal(made.status,201);assert.equal(made.data.status,'unverified');
 const pub=(await api(e,'/api/closures')).data.find(c=>c.id===made.data.id);
 assert.equal(pub.note,'');assert.equal(pub.kind,'report');assert.equal(pub.ai,undefined);
 const staff=(await api(e,'/api/closures','GET',undefined,'staff')).data.find(c=>c.id===made.data.id);
 assert.equal(staff.note,'call 555-0100, gate locked by J. Smith');
 // A walking route past it warns without the note; staff routing sees the note.
 const w=(await route()).summary.warnings.find(x=>x.id===made.data.id);assert.ok(w,'the route passes the report');
 assert.equal(w.note,'');assert.equal((await route('staff')).summary.warnings.find(x=>x.id===made.data.id).note,'call 555-0100, gate locked by J. Smith');
 // The assistant's facts never carry the note either.
 const facts=collectFacts(context,Date.now(),{closures:[made.data],answers:[],rules:[]});
 assert.ok(facts.some(f=>f.id==='report:'+made.data.id));assert.ok(!JSON.stringify(facts).includes('555-0100'));
 // Once approved, it is staff-checked: the note shows.
 await api(e,'/api/closures/'+made.data.id+'/approve','POST',{},'staff');
 assert.equal((await api(e,'/api/closures')).data.find(c=>c.id===made.data.id).note,'call 555-0100, gate locked by J. Smith');
});
test('pages are served with headers that stop other sites embedding them',()=>{
 const h=readFileSync(new URL('../outdoor/static/_headers',import.meta.url),'utf8');
 assert.match(h,/^\/\*$/m);assert.match(h,/frame-ancestors 'none'/);assert.match(h,/X-Frame-Options: DENY/);
 for(const cdn of ['https://cdnjs.cloudflare.com','https://cdn.jsdelivr.net','https://unpkg.com'])assert.ok(h.includes(cdn),cdn);
 // Every external script a page loads must be allowed by script-src.
 const allowed=h.match(/script-src ([^;]+)/)[1].split(' ');
 for(const page of ['index.html','indoor/index.html','create/index.html','booth/index.html','survey/index.html','stats/index.html']){
  const html=readFileSync(new URL('../outdoor/static/'+page,import.meta.url),'utf8');
  for(const [,src] of html.matchAll(/(?:<script[^>]+src="|"(?:three|three\/addons\/)":")(https:\/\/[^/"]+)/g))assert.ok(allowed.includes(src),page+' loads '+src);
 }
});

test('Lot 2: its 2-hour limit and its Text2Park page; an event price or a permit lifts the limit',()=>{
 const at=parseTime('2026-11-24T12:00'),lot2=(rules=[],cred={})=>parkingState(context,at,rules,cred).find(p=>p.id==='lot2');
 assert.equal(lot2().max_stay_hours,2);
 assert.equal(lot2().pay_url,'https://usc.park.tez.io/location/LOT2');
 // Codes come from the signs, never guessed. Flower takes Text2Park only, so its link is always there.
 const all=parkingState(context,at,[],{});
 assert.equal(all.find(p=>p.id==='flower').pay_url,'https://usc.park.tez.io/location/FLWR');
 // Downey before 4 pm Mon-Thu is pay station only: no Text2Park link until it takes phones.
 assert.equal(all.find(p=>p.id==='downey').pay_url,null);
 assert.equal(parkingState(context,parseTime('2026-11-24T17:00'),[],{}).find(p=>p.id==='downey').pay_url,'https://usc.park.tez.io/location/DWNY');
 assert.ok(all.every(p=>p.pay_url===null||/^https:\/\/usc\.park\.tez\.io\/location\/[A-Z0-9]+$/.test(p.pay_url)));
 // Height limits reach the page; Lot 2 is open, and a structure with no figure on file says so (no guess).
 assert.equal(all.find(p=>p.id==='royal').clearance_in,74);assert.equal(all.find(p=>p.id==='lot2').open_lot,true);assert.equal(all.find(p=>p.id==='flower').clearance_in,undefined);
 const event={id:'e',kind:'rate',parking:'lot2',option:'event',price:20,starts_ms:at-3600000,ends_ms:at+3600000,created_ms:0,updated:'2026-11-24T11:00'};
 assert.equal(lot2([event]).max_stay_hours,null);
 assert.equal(lot2([event]).pay_url,null);      // staff's event price is paid however staff said, not by Text2Park
});

test('a stay longer than a structure\'s time limit skips it, says so, and a chosen structure is never second-guessed',async()=>{
 // From the west with Downey closed by staff, Lot 2 is the closest structure to Sample Hall.
 const tour={...body,from:{lat:34.0230,lon:-118.2950},parking:'auto',to:'Sample Hall'},when=parseTime('2026-11-24T12:00');
 const shut=[{id:'s',kind:'parking',parking:'downey',applies:'everyone',status:'closed',starts_ms:when-3600000,ends_ms:when+36000000,ends:'2026-11-24T22:00',created_ms:0,updated:'2026-11-24T11:00',note:''}];
 const unsure=await drivingRoute(context,tour,when,shut,[],env(),provider().fn);
 assert.equal(unsure.ok,true);
 assert.equal(unsure.summary.parking.id,'lot2');{
   // Not sure how long: the closest pick stands, with its limit and a named way out.
   assert.equal(unsure.summary.parking.max_stay_hours,2);
   assert.ok(unsure.summary.longer_stay_option&&unsure.summary.longer_stay_option.id!=='lot2');
 }
 const long=await drivingRoute(context,{...tour,stay_hours:4},when,shut,[],env(),provider().fn);
 assert.equal(long.ok,true);assert.notEqual(long.summary.parking.id,'lot2');
 assert.equal(long.summary.longer_stay_option,null);
 assert.deepEqual(long.summary.skipped_for_stay.map(t=>t.id),['lot2']);
 const short=await drivingRoute(context,{...tour,stay_hours:2},when,shut,[],env(),provider().fn);
 assert.equal(short.summary.parking.id,unsure.summary.parking.id);
 const chosen=await drivingRoute(context,{...tour,parking:'lot2',stay_hours:4},when,shut,[],env(),provider().fn);
 assert.equal(chosen.ok,true);assert.equal(chosen.summary.parking.id,'lot2');
 await assert.rejects(drivingRoute(context,{...tour,stay_hours:25},when,shut,[],env(),provider().fn),/between 0 and 24/);
});

test('event links carry how long people stay, and the map page reads it',()=>{
 const page=readFileSync(new URL('../outdoor/static/index.html',import.meta.url),'utf8');
 for(const v of ['2','4','10'])assert.match(page,new RegExp('<select id="stay">.*<option value="'+v+'">'));
 assert.match(page,/stay_hours:mode==='driving'&&\$\('stay'\)\.value/);
 // The pay link only ever points at Text2Park's own location page.
 assert.ok(page.includes(String.raw`/^https:\/\/usc\.park\.tez\.io\/location\/[A-Z0-9_-]+$/.test(p.pay_url)`));
});

test('campus legs follow the campus roads; one nobody has mapped is not drawn as a straight line',()=>{
 const at=parseTime('2026-11-24T12:00'),gates=gateState(context,at,[],{}),park=parkingState(context,at,[],{});
 const leg=(sid,gid)=>{const p=park.find(x=>x.id===sid),o=p.access.find(a=>a.gate===gid);return wayIn(context,gates.find(g=>g.id===gid),{...p,entrance:o.entrance,campus_via:o.campus_via});};
 // McClintock Ave. Entrance to the Royal structure: along 34th St, not straight across the north of campus.
 const royal=leg('royal','mcclintock');
 assert.equal(royal.campusMapped,true);assert.equal(royal.campus.length,5);   // drive_to, gate pin, corner, 34th St junction, entrance
 assert.ok(royal.campus.some(([lon,lat])=>Math.abs(lat-34.0242865)<1e-6&&Math.abs(lon+118.2875897)<1e-6),'turns at 34th St and McClintock');
 // ...to its 34th St car entrance, not round to the Jefferson one on the far side of the structure.
 const r=parkingState(context,parseTime('2026-11-24T12:00'),[],{}).find(x=>x.id==='royal');
 for(const g of ['mcclintock','downey-way'])assert.equal(r.access.find(a=>a.gate===g).entrance.id,'ROYAL.veh.34th',g);
 assert.equal(r.access.find(a=>a.gate==='royal').entrance.id,'ROYAL.veh.jefferson');
 assert.ok(royal.campusM>500&&royal.campusM<700,String(royal.campusM));
 // Watt Way to the Royal structure is not mapped: nothing drawn, the length padded, closures still checked on the best guess.
 const watt=leg('royal','watt');
 assert.equal(watt.campusMapped,false);assert.deepEqual(watt.campus,[]);assert.equal(watt.line.length,2);
 assert.ok(watt.campusM>watt.line.slice(1).reduce((s,c,i)=>s+haversine([watt.line[i][1],watt.line[i][0]],[c[1],c[0]]),0));
 // Every way in with a long leg either has points to follow or is knowingly unmapped (Watt Way only, for now).
 for(const p of park)for(const o of p.access){const w=wayIn(context,gates.find(g=>g.id===o.gate),{...p,entrance:o.entrance,campus_via:o.campus_via});
   if(!w.campusMapped)assert.equal(o.gate,'watt',p.id+' via '+o.gate+' is a long unmapped leg');}
});

test('from the northeast, no driving across campus from Royal Street Entrance: public roads to a nearer entrance',async()=>{
 // The screenshot case: Sample Hall from near the 110. Same provider time for every way in, so campus roads decide.
 const out=await drivingRoute(context,{...body,from:{lat:34.0285,lon:-118.2735},parking:'auto',to:'Sample Hall'},parseTime('2026-11-24T12:00'),[],[],env(),provider().fn);
 assert.equal(out.ok,true);
 assert.ok(!(out.summary.parking.id==='lot2'&&out.summary.gate.id==='royal'),'Royal Street Entrance to Lot 2');
 assert.ok(out.summary.campus_m<800,out.summary.parking.id+' via '+out.summary.gate.id+': '+out.summary.campus_m+' m on campus');
});

test('the drive to an entrance goes around campus, never through it',()=>{
 const ne=[34.0285,-118.2735],gate=id=>{const g=gateState(context,parseTime('2026-11-24T12:00'),[],{}).find(x=>x.id===id);return [g.lat,g.lon];};
 // McClintock is on Jefferson, facing the northeast: straight there.
 assert.equal(Math.round(aroundCampus(ne,gate('mcclintock'))),Math.round(haversine(ne,gate('mcclintock'))));
 // Downey Way is on Vermont, across campus: round the Jefferson/Vermont corner, much longer than the straight line.
 assert.ok(aroundCampus(ne,gate('downey-way'))>haversine(ne,gate('downey-way'))+150);
 // Starting on campus: no detour to invent.
 assert.equal(aroundCampus([34.0205,-118.2855],gate('watt')),haversine([34.0205,-118.2855],gate('watt')));
});

test('from the northeast, the routing service is asked about McClintock, not Downey Way or Royal, for Lot 2',async()=>{
 const mock=provider();
 await drivingRoute(context,{...body,from:{lat:34.0285,lon:-118.2735},parking:'auto',to:'Sample Hall'},parseTime('2026-11-24T12:00'),[],[],env(),mock.fn);
 const gates=gateState(context,parseTime('2026-11-24T12:00'),[],{}),asked=mock.calls.map(c=>{const [lon,lat]=c.body.coordinates[1];return gates.find(g=>[[g.lat,g.lon],g.drive_to].some(q=>q&&Math.abs(q[0]-lat)<1e-6&&Math.abs(q[1]-lon)<1e-6))?.id;});
 assert.ok(asked.includes('mcclintock'),asked.join());
 assert.ok(!asked.includes('downey-way')&&!asked.includes('royal'),asked.join());
});

test('Royal Street Entrance is a way in to the Royal structure only: to reach 34th St you drive through it',()=>{
 for(const p of context.mobilityData.parking)for(const a of p.access||[])
   if(a.gate==='royal')assert.equal(p.id,'royal',p.id+' lists Royal Street Entrance as a way in');
});

test('fewest turns: a slightly faster way in with more turns loses to a simple one',async()=>{
 // North of campus to Sample Hall: Lot 2 via McClintock (in off Jefferson, one turn to the lot) or via Downey Way
 // (round to Vermont first). Same drive time; Downey Way has the shorter campus leg but four turns on public roads.
 const gates=gateState(context,parseTime('2026-11-24T12:00'),[],{}),dw=gates.find(g=>g.id==='downey-way');
 const fn=async(url,options)=>{const d=JSON.parse(options.body),[lon,lat]=d.coordinates[1],far=Math.abs(lat-dw.lat)<1e-6&&Math.abs(lon-dw.lon)<1e-6;
   const steps=[{type:11,instruction:'Head south',distance:10,duration:5},...Array.from({length:far?4:1},(_,i)=>({type:i%2,instruction:'Turn',distance:100,duration:20})),{type:10,instruction:'Arrive',distance:0,duration:0}];
   return new Response(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:d.coordinates},properties:{summary:{duration:240,distance:1200},segments:[{steps}]}}]}),{status:200});};
 const out=await drivingRoute(context,{...body,from:{lat:34.0336,lon:-118.2817},parking:'lot2',to:'Sample Hall'},parseTime('2026-11-24T12:00'),[],[],env(),fn);
 assert.equal(out.ok,true);assert.equal(out.summary.gate.id,'mcclintock');assert.equal(out.summary.turns,2);
});

test('a route that reaches the entrance, drives on to turn round and comes back is cut where it got there',()=>{
 // The screenshot: down to Jefferson at McClintock, west 426 m to Vermont, U-turn, 417 m back to the entrance.
 const gate={lat:34.0250085,lon:-118.2871694},north=[-118.2869,34.0262],corner=[-118.28715,34.02522],vermont=[-118.291553,34.02549],back=[-118.287132,34.025069];
 const steps=[{type:11,instruction:'Head south on McClintock',distance:135,duration:30},{type:1,instruction:'Turn right onto West Jefferson Boulevard',distance:426,duration:60},
   {type:2,instruction:'Turn sharp left onto West Jefferson Boulevard',distance:417,duration:60},{type:10,instruction:'Arrive',distance:0,duration:0}];
 const route=coords=>({type:'Feature',geometry:{type:'LineString',coordinates:coords},properties:{summary:{duration:150,distance:978},segments:[{steps}]}});
 const cut=cutLoop(route([north,corner,vermont,back]),gate,30);
 assert.deepEqual(cut.geometry.coordinates,[north,corner]);
 assert.deepEqual(cut.properties.segments[0].steps.map(x=>x.instruction),['Head south on McClintock']);
 assert.ok(cut.properties.summary.distance<200&&cut.properties.summary.duration<40,JSON.stringify(cut.properties.summary));
 assert.ok(cut.properties.loop_cut_m>800);
 // Arriving straight in: nothing to cut.
 const straight=route([north,corner,back]);assert.equal(cutLoop(straight,gate,30),straight);
 // A few metres on past the pin to the curb is not a loop.
 const curb=route([north,corner,[-118.2873,34.02505],back]);assert.equal(cutLoop(curb,gate,30),curb);
});

test('driving past a gate for people on foot is not driving through a closed gate',async()=>{
 // From Jefferson / Figueroa the drive goes down Figueroa past the DCC-PSD gate (locked, on foot only): both options were rejected.
 const psd=context.mobilityData.gates.find(g=>g.id==='dcc-psd'),wed=parseTime('2026-11-25T12:00');
 assert.equal(gateState(context,wed,[],{}).find(g=>g.id==='dcc-psd').pedestrian.status,'closed');
 const past=provider(([a,b])=>[a,[psd.lon,psd.lat],b]);
 const out=await drivingRoute(context,{...body,from:{lat:34.021904,lon:-118.280003},parking:'mccarthy',to:'Sample Hall'},wed,[],[],env(),past.fn);
 assert.equal(out.ok,true,JSON.stringify(out.checks));
});

test('Watt Way: up to Downey Way, then along it to Lot 2 or to McClintock for Downey',()=>{
 const at=parseTime('2026-11-24T12:00'),gates=gateState(context,at,[],{}),park=parkingState(context,at,[],{});
 const leg=sid=>{const p=park.find(x=>x.id===sid),o=p.access.find(a=>a.gate==='watt');return wayIn(context,gates.find(g=>g.id==='watt'),{...p,entrance:o.entrance,campus_via:o.campus_via});};
 const lot2=leg('lot2'),downey=leg('downey');
 assert.equal(lot2.campusMapped,true);assert.equal(downey.campusMapped,true);
 assert.ok(lot2.campusM>280&&lot2.campusM<340,String(lot2.campusM));   // 244 m up Watt Way + 65 m along Downey Way
 assert.ok(lot2.campus.some(([lon,lat])=>Math.abs(lat-34.0203897)<1e-6&&Math.abs(lon+118.28774)<1e-6));
});

test('McClintock: the drive ends in the middle of the intersection, reachable from every direction',async()=>{
 const at=parseTime('2026-11-24T12:00'),gate=gateState(context,at,[],{}).find(g=>g.id==='mcclintock'),lot2=parkingState(context,at,[],{}).find(p=>p.id==='lot2');
 const o=lot2.access.find(a=>a.gate==='mcclintock'),w=wayIn(context,gate,{...lot2,entrance:o.entrance,campus_via:o.campus_via});
 assert.deepEqual([w.target.lat,w.target.lon],gate.drive_to);
 // The dashed campus leg starts there and passes the gate pin.
 assert.deepEqual(w.campus[1],[gate.lon,gate.lat]);
 // ...and the routing service is asked for that point, not the pin.
 const mock=provider();await drivingRoute(context,{...body,from:{lat:34.0336,lon:-118.2817},parking:'lot2',to:'Sample Hall'},at,[],[],env(),mock.fn);
 assert.ok(mock.calls.some(c=>{const [lon,lat]=c.body.coordinates[1];return lat===gate.drive_to[0]&&lon===gate.drive_to[1];}),JSON.stringify(mock.calls.map(c=>c.body.coordinates[1])));
});
