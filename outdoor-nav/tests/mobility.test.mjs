import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {WalkRouter, haversine} from '../cloudflare/router.mjs';
import {parseTime,campusISO,gateStatus,handleApi} from '../cloudflare/api.mjs';
import {gateState,parkingState,footballContext,avoidance,intersectsPolygon,drivingRoute,validateRule,readRules,circlePolygon,GATE_AVOID_RADIUS_M} from '../cloudflare/mobility.mjs';
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
 assert.equal(weekday.find(g=>g.id==='pardee').eligible,false);
 assert.equal(weekend.find(g=>g.id==='flower').eligible,false);
 assert.equal(gateState(context,saturday,[],{usc_id:true}).find(g=>g.id==='flower').eligible,true);
});
test('home games activate precautionary avoidance; away games do not',()=>{
 assert.equal(footballContext(context.footballData,saturday).game,null);
 const game=parseTime('2026-11-21T09:00:00');assert.equal(footballContext(context.footballData,game).game.opponent,'Maryland');
 assert.ok(avoidance(context,game,game+1,[],{}).some(a=>a.basis==='precaution_not_confirmed'));
 assert.equal(avoidance(context,saturday,saturday+1,[],{}).some(a=>a.basis==='precaution_not_confirmed'),false);
 assert.equal(footballContext(context.footballData,parseTime('2027-01-01T09:00')).known_season,false);
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
test('a valid driving route forces a gate, uses the vehicle entrance, and previews the surveyed walking exit',async()=>{
 const e=env(),mock=provider(),out=await drivingRoute(context,body,monday,[],[],e,mock.fn);
 assert.equal(out.ok,true);assert.equal(out.mode,'driving');assert.equal(out.summary.parking.id,'downey');assert.equal(out.summary.live_traffic,false);
 assert.equal(out.handoff.exit,'DOWNEY.ped.main');assert.equal(out.walking_preview.summary.start_place.exit,'DOWNEY.ped.main');
 assert.equal(mock.calls.length,1);assert.equal(mock.calls[0].body.coordinates.length,3);
 assert.deepEqual(mock.calls[0].body.coordinates.at(-1),[-118.28997731807364,34.02077789075529]);
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
test('a provider cannot skip the requested gate or snap to a different parking entrance',async()=>{
 for(const transform of [coords=>[coords[0],coords.at(-1)],coords=>[...coords.slice(0,-1),[-118.30,34.02]]]){
  const out=await drivingRoute(context,body,monday,[],[],env(),provider(transform).fn);assert.equal(out.ok,false);
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
 const out=await drivingRoute(context,body,monday,[rule],[],env(),provider().fn);assert.equal(out.ok,false);
});
test('a gate closing before arrival cannot be recommended',async()=>{
 const at=parseTime('2026-11-14T15:29:00'),out=await drivingRoute(context,{...body,parking:'jefferson'},at,[],[],env(),provider().fn);
 assert.equal(out.ok,false);
});
test('walking-only reports do not block vehicle routing',async()=>{
 const closure={id:'ped',lat:34.0250085,lon:-118.2871694,radius_m:30,status:'approved',starts:'2026-11-16T10:00',ends:'2026-11-16T14:00',modes:['walking']};
 const out=await drivingRoute(context,body,monday,[],[closure],env(),provider().fn);assert.equal(out.ok,true);
 const car=await drivingRoute(context,body,monday,[],[{...closure,modes:['driving']}],env(),provider().fn);assert.equal(car.ok,false);
});
test('missing key, missing D1, out-of-range starts and provider quota fail explicitly',async()=>{
 await assert.rejects(()=>drivingRoute(context,body,monday,[],[],{DB:new D1()},provider().fn),e=>e.status===503);
 await assert.rejects(()=>drivingRoute(context,body,monday,[],[],{ORS_API_KEY:'key'},provider().fn),e=>e.status===503);
 await assert.rejects(()=>drivingRoute(context,{...body,from:{lat:0,lon:0}},monday,[],[],env(),provider().fn),e=>e.status===400);
 await assert.rejects(()=>drivingRoute(context,body,monday,[],[],env(),provider(undefined,429).fn),e=>e.status===429);
});
test('global quota counts upstream requests and refuses before hitting the provider',async()=>{
 const e=env(),slot='minute:'+Math.floor(Date.now()/60000);e.DB.db.prepare('INSERT INTO routing_usage VALUES(?,?,?)').run(slot,10,Date.now()+120000);
 const mock=provider();await assert.rejects(()=>drivingRoute(context,body,monday,[],[],e,mock.fn),e=>e.status===429);assert.equal(mock.calls.length,0);
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
test('closed gates with approximate pins do not close public streets; surveyed gates get a small circle',async()=>{
 const sat=parseTime('2026-11-14T20:00:00'),areas=avoidance(context,sat,sat+1800000,[],{});
 const ids=areas.map(a=>a.id);
 assert.ok(ids.includes('gate:watt'),ids);                                  // surveyed, closed on weekends
 for(const approx of ['gate:downey-way','gate:pardee','gate:royal'])assert.ok(!ids.includes(approx),approx);
 const watt=areas.find(a=>a.id==='gate:watt').geometry.coordinates[0][0];   // a ring point
 const r=haversine([watt[1],watt[0]],[34.0184081,-118.2889172]);assert.ok(r<=GATE_AVOID_RADIUS_M+1,r);
});
test('driving past a closed gate with an approximate pin (Vermont / 36th Pl) is not a rejection',async()=>{
 const past=coords=>[coords[0],[-118.29145,34.02149],...coords.slice(1)];  // via the downey-way pin
 const out=await drivingRoute(context,body,parseTime('2026-11-14T20:00:00'),[],[],env(),provider(past).fn);
 assert.equal(out.ok,true,JSON.stringify(out.checks));
});
test('a failed driving search says which check rejected each candidate',async()=>{
 const out=await drivingRoute(context,body,monday,[],[],env(),provider(c=>c,404).fn);
 assert.equal(out.ok,false);assert.ok(out.checks.length>=1);assert.equal(out.checks[0].check,'provider returned no route');assert.equal(out.checks[0].status,404);
});
// Live: openrouteservice refused with "Could not find routable point within a radius
// of 25.0 meters of specified coordinate 0" -- the off-road start. Each point now
// gets its own search radius; the parking entrance stays strict.
test('driving request gives the start a wide road-search radius and the entrance a strict one',async()=>{
 const mock=provider(),out=await drivingRoute(context,body,monday,[],[],env(),mock.fn);
 assert.equal(out.ok,true);
 const r=mock.calls[0].body.radiuses;assert.equal(r.length,mock.calls[0].body.coordinates.length);
 assert.equal(r[0],300);assert.equal(r.at(-1),25);
});
