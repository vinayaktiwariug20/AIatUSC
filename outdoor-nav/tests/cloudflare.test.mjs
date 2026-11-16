import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import worker from '../cloudflare/worker.mjs';
import {campusISO,parseTime} from '../cloudflare/api.mjs';

class D1 {
  constructor(migrate=true) {
    this.db=new DatabaseSync(':memory:');
    if(migrate)for(const name of ['0001_closures.sql','0002_mobility.sql'])this.db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  prepare(sql) {
    let params=[]; const self=this;
    return {bind(...values){params=values;return this;},async first(column){const row=self.db.prepare(sql).get(...params);return row ? column ? row[column] : row : null;},async run(){return self.db.prepare(sql).run(...params);}};
  }
}
const route={from:{lat:34.0187,lon:-118.2905},to:'Doheny',at:'2026-11-14T12:00:00'};
const report={lat:34.020,lon:-118.287,note:'temporary barrier',starts:'2026-11-14T10:00:00',ends:'2026-11-14T14:00:00'};
function request(path,method='GET',body,token) {
  return new Request('https://example.test'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{'X-Admin-Token':token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
}
async function call(env,path,method='GET',body,token) {const r=await worker.fetch(request(path,method,body,token),env);return {status:r.status,data:await r.json(),headers:r.headers};}
const env=()=>({DB:new D1(),ADMIN_TOKEN:'test-secret',PUBLIC_REPORTS_ENABLED:'true'});
const at='/api/closures?at=2026-11-14T12:00:00';

test('no database means explicit read-only preview, with walking route available',async()=>{
  const health=await call({},'/api/health');assert.equal(health.status,200);assert.equal(health.data.storage,'read_only_preview');assert.equal(health.data.driving_routes,false);assert.equal(health.data.turn_by_turn,false);
  assert.deepEqual((await call({},'/api/closures')).data,[]);
  const out=await call({},'/api/outdoor/route','POST',route);assert.equal(out.data.ok,true);assert.equal(out.data.summary.storage,'read_only_preview');
  assert.equal((await call({},'/api/closures','POST',report)).status,503);
});
test('health verifies schema and does not expose the admin secret',async()=>{
  const e=env(),h=await call(e,'/api/health');assert.equal(h.data.database,'connected');assert.equal(JSON.stringify(h.data).includes(e.ADMIN_TOKEN),false);
  assert.equal((await call({DB:new D1(false)},'/api/health')).data.database,'migration_required');
});
test('buildings and places preserve the original API shape',async()=>{
  const rows=(await call({},'/api/buildings?q=doheny')).data;assert.ok(rows.length);assert.ok(rows.every(b=>b.name.toLowerCase().includes('doheny')));
  const b=(await call({},'/api/buildings/'+rows[0].id)).data;assert.equal(b.id,rows[0].id);
  assert.ok((await call({},'/api/places')).data.some(p=>p.id==='royal'));
});
test('unverified reports persist across calls and never change the walking route',async()=>{
  const e=env(),plain=(await call(e,'/api/outdoor/route','POST',route)).data;
  const c=await call(e,'/api/closures','POST',report);assert.equal(c.status,201);assert.equal(c.data.status,'unverified');
  assert.equal((await call({...e},at)).data[0].id,c.data.id);
  const next=(await call(e,'/api/outdoor/route','POST',route)).data;assert.deepEqual(next.features,plain.features);
});
test('approval is authenticated, persists, and produces a detour',async()=>{
  // Close a point ON the current route (its midpoint), so the test does not
  // depend on which paths the map happens to have.
  const e=env(),line=(await call(e,'/api/outdoor/route','POST',route)).data.features[0].geometry.coordinates;
  const [mlon,mlat]=line[Math.floor(line.length/2)];
  const c=(await call(e,'/api/closures','POST',{...report,lat:mlat,lon:mlon,radius_m:10})).data,p='/api/closures/'+c.id;
  assert.equal((await call(e,p+'/approve','POST',{})).status,403);
  assert.equal((await call(e,p+'/approve','POST',{},'test-secret')).data.status,'approved');
  const out=(await call(e,'/api/outdoor/route','POST',route)).data;assert.ok(out.summary.avoided.some(x=>x.closure===c.id));
  assert.equal((await call(e,p+'/reject','POST',{},'test-secret')).data.status,'rejected');assert.deepEqual((await call(e,at)).data,[]);
});
test('updating one report does not erase another',async()=>{
  const e=env(),a=(await call(e,'/api/closures','POST',report)).data,b=(await call(e,'/api/closures','POST',{...report,note:'second'})).data;
  await call(e,'/api/closures/'+a.id+'/approve','POST',{},'test-secret');
  assert.deepEqual(new Set((await call(e,at)).data.map(x=>x.id)),new Set([a.id,b.id]));
});
test('authenticated deletion removes the report',async()=>{
  const e=env(),c=(await call(e,'/api/closures','POST',report)).data,p='/api/closures/'+c.id;
  assert.equal((await call(e,p,'DELETE')).status,403);assert.equal((await call(e,p,'DELETE',undefined,'test-secret')).status,200);assert.deepEqual((await call(e,at)).data,[]);
});
test('staff reports are approved immediately and expire without reopening',async()=>{
  const e=env(),c=(await call(e,'/api/closures','POST',report,'test-secret')).data;assert.equal(c.status,'approved');
  assert.deepEqual((await call(e,'/api/closures?at=2026-11-14T15:00:00')).data,[]);
});
test('a missing reporting variable keeps writes off; staff still have access',async()=>{
  const e={DB:new D1(),ADMIN_TOKEN:'test-secret'};assert.equal((await call(e,'/api/closures','POST',report)).status,403);assert.equal((await call(e,'/api/closures','POST',report,'test-secret')).status,201);
  assert.equal((await call({DB:new D1()},'/api/closures/abc/approve','POST',{})).status,403);
});
test('configured storage failure never produces a route ignoring closures',async()=>{
  const bad={DB:{prepare(){throw new Error('internal secret');}}},out=await call(bad,'/api/outdoor/route','POST',route);
  assert.equal(out.status,503);assert.equal(out.data.ok,false);assert.equal(JSON.stringify(out.data).includes('internal secret'),false);
});
test('invalid JSON shapes, coordinates, intervals and dates are rejected',async()=>{
  for(const value of [[],null,'text',{to:'Doheny'},{...route,at:'bad'},{...route,from:{lat:null,lon:-118}}]) assert.equal((await call({},'/api/outdoor/route','POST',value)).status,400);
  assert.equal((await call(env(),'/api/closures','POST',{...report,radius_m:-1})).status,400);
  assert.equal((await call({},'/api/gates?at=bad')).status,400);
});
test('far-away start is refused before graph exploration',async()=>{
  const out=await call({},'/api/outdoor/route','POST',{...route,from:{lat:0,lon:0}});assert.equal(out.data.ok,false);assert.match(out.data.reason,/outside/);
});
test('driving without a configured key is never silently answered with a walking route',async()=>{assert.equal((await call({},'/api/outdoor/route','POST',{...route,mode:'driving'})).status,503);});
test('Los Angeles timestamps and gate schedules handle UTC offsets',async()=>{
  assert.equal(parseTime('2026-11-16T22:00:00'),parseTime('2026-11-17T06:00:00Z'));
  assert.equal(campusISO(parseTime('2026-11-17T06:00:00Z')),'2026-11-16T22:00:00-08:00');
  assert.equal(campusISO(parseTime('2026-07-14T20:00:00Z')),'2026-07-14T13:00:00-07:00');
  assert.deepEqual((await call({},'/api/gates?at=2026-11-17T06:00:00Z')).data.gates,(await call({},'/api/gates?at=2026-11-16T22:00:00')).data.gates);
});
test('unknown API stays JSON 404; HEAD and method limits are correct',async()=>{
  for(const p of ['/api','/api/nope'])assert.equal((await call({},p)).status,404);
  const h=await worker.fetch(request('/api/health','HEAD'),{});assert.equal(h.status,200);assert.equal(await h.text(),'');assert.equal(h.headers.get('cache-control'),'no-store');
  assert.equal((await worker.fetch(request('/api/health','PUT'),{})).status,405);
});
test('named parking exits retain vehicle-hours metadata for the walking leg',async()=>{
  const out=await call({},'/api/outdoor/route','POST',{...route,from:{place:'royal'},to:'norris theatre'});assert.equal(out.data.ok,true);assert.ok(Array.isArray(out.data.summary.vehicle_access));
});
test('static assets delegate to Cloudflare without exposing API data',async()=>{
  const req=request('/'),response=await worker.fetch(req,{ASSETS:{fetch(r){assert.equal(r,req);return new Response('static');}}});assert.equal(await response.text(),'static');
});
test('request-size and JSON syntax guards work before storage or routing',async()=>{
  // Reports may carry one compressed photo (limit 450 KB); every other endpoint stays at 16 KB.
  const oversized=new Request('https://example.test/api/closures',{method:'POST',body:'x'.repeat(460000)});assert.equal((await worker.fetch(oversized,{})).status,413);
  const oversizedRoute=new Request('https://example.test/api/outdoor/route',{method:'POST',body:'x'.repeat(17000)});assert.equal((await worker.fetch(oversizedRoute,{})).status,413);
  const bad=new Request('https://example.test/api/closures',{method:'POST',body:'{'});assert.equal((await worker.fetch(bad,{})).status,400);
});
test('compiled graph is up to date with its source JSON datasets',()=>{
  const graph=JSON.parse(readFileSync(new URL('../cloudflare/graph.json',import.meta.url),'utf8'));
  for(const [file,expected] of Object.entries(graph.source_sha256)){
    // Line endings normalised, as in build_cloudflare_graph.py: CRLF on Windows checkouts, LF on CI.
    const text=readFileSync(new URL('../data/'+file,import.meta.url),'utf8').replace(/\r\n/g,'\n');
    const actual=createHash('sha256').update(text,'utf8').digest('hex');
    assert.equal(actual,expected,'Source data changed: run npm run build:graph before deployment.');
  }
});
test('object prototype names cannot masquerade as buildings or start places',async()=>{
  assert.equal((await call({},'/api/buildings/constructor')).status,404);
  assert.equal((await call({},'/api/outdoor/route','POST',{...route,to:'__proto__'})).data.ok,false);
  assert.equal((await call({},'/api/outdoor/route','POST',{...route,from:{place:'constructor'}})).data.ok,false);
});
test('start on a long footway snaps to the segment, not a far node (no loop)',async()=>{
  // Tutor Center footway: nearest-NODE snapping walked west to a corner and back.
  const out=(await call({},'/api/outdoor/route','POST',{from:{lat:34.01995,lon:-118.28690},to:'Doheny'})).data;
  assert.equal(out.ok,true);assert.ok(out.summary.snap_m<15);
  const lons=out.features[0].geometry.coordinates.map(c=>c[0]);assert.ok(Math.min(...lons)>-118.28690-0.0003);
});
test('campus malls tagged cycleway are walkable (Childs Way / Watt Way)',async()=>{
  const out=(await call({},'/api/outdoor/route','POST',{from:{lat:34.02065,lon:-118.28720},to:'Doheny'})).data;
  assert.ok(out.summary.metres<500,out.summary.metres);
});
test('a report without migration 0002 gets a clear "database needs an update" error, not "storage unavailable"',async()=>{
  const d=new D1(false);d.db.exec(readFileSync(new URL('../migrations/0001_closures.sql',import.meta.url),'utf8'));
  const r=await call({DB:d,PUBLIC_REPORTS_ENABLED:'true'},'/api/closures','POST',report);
  assert.equal(r.status,503);assert.match(r.data.error,/migration 0002/);
});
test('the building list carries official codes, so organizers can search TCC or DMC',async()=>{
  const rows=(await call({},'/api/buildings?q=tcc')).data;
  assert.ok(rows.some(b=>b.name==='Ronald Tutor Campus Center'&&b.aliases.includes('TCC')),JSON.stringify(rows.slice(0,2)));
});
