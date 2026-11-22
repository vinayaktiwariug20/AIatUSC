// The outdoor map's hand-off to the indoor viewer, and the local preview server.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {route, findPlace, placeEnd} from '../outdoor/static/indoor/nav.mjs';
import worker from '../cloudflare/worker.mjs';
import {createLocalServer} from '../tools/dev-indoor.mjs';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const html=read('../outdoor/static/index.html');
const B=JSON.parse(read('../outdoor/static/indoor/building.json'));
// The page's own link builder, run outside the page.
// (with the helpers that decide whether a building is the event's)
const indoorHref=html.slice(html.indexOf("// \"Ronald Tutor"),html.indexOf('function updateIndoorView('));
const buildings=[{id:B.id,name:'Dr. Joseph Medicine Crow Center for International and Public Affairs',aliases:['DMC']},{id:'rtcc',name:'Ronald Tutor Campus Center',aliases:['TCC']}];

test('the event link reaches the indoor viewer with a door and a room it knows, and a route between them',async()=>{
  const event=new URL('https://example.test/?to=DMC&room=258');
  const response=await worker.fetch(new Request('http://test/api/outdoor/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:{lat:34.0215019,lon:-118.2840557},to:event.searchParams.get('to')})}),{});
  const result=await response.json();assert.equal(result.ok,true);assert.equal(result.handoff.indoor_node,'entrance');
  const sandbox=vm.createContext({URLSearchParams,buildings,qs:event.searchParams,summary:result.summary,handoff:result.handoff});
  const link=new URL(vm.runInContext(indoorHref+'\nindoorHref(summary,handoff)',sandbox),'http://test');
  assert.equal(link.pathname,'/indoor/');
  assert.equal(link.searchParams.get('building'),B.id);assert.equal(link.searchParams.get('entrance'),'jmc-main');
  const from=findPlace(B,link.searchParams.get('anchor')),to=findPlace(B,link.searchParams.get('room'));
  assert.equal(from.id,'entrance');assert.equal(to.id,'258');
  const r=route(B.nav,placeEnd(B,from),placeEnd(B,to));
  assert.ok(r);assert.equal(r.points.at(-1).floor,2);
});

test('the event link can name where indoor directions start (anchor=), instead of the door',async()=>{
  const event=new URL('https://example.test/?to=DMC&room=258&anchor=left-stair-1');
  const response=await worker.fetch(new Request('http://test/api/outdoor/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:{lat:34.0215019,lon:-118.2840557},to:event.searchParams.get('to')})}),{});
  const result=await response.json();assert.equal(result.handoff.indoor_node,'entrance');
  const sandbox=vm.createContext({URLSearchParams,buildings,qs:event.searchParams,summary:result.summary,handoff:result.handoff});
  const link=new URL(vm.runInContext(indoorHref+'\nindoorHref(summary,handoff)',sandbox),'http://test');
  assert.equal(link.searchParams.get('anchor'),'left-stair-1');assert.equal(link.searchParams.get('room'),'258');
  assert.equal(link.searchParams.get('building'),B.id);assert.equal(link.searchParams.get('entrance'),'jmc-main');   // the door is still reported
  const from=findPlace(B,link.searchParams.get('anchor')),to=findPlace(B,link.searchParams.get('room'));
  assert.equal(from.id,'left-stair-1');assert.equal(to.id,'258');
  const r=route(B.nav,placeEnd(B,from),placeEnd(B,to));assert.ok(r);assert.equal(r.points.at(-1).floor,2);
  // The Indoor View button carries it too, before any route exists.
  const early=new URL(vm.runInContext(indoorHref+"\nindoorHref({building:'DMC'})",vm.createContext({URLSearchParams,buildings,qs:event.searchParams})),'http://test');
  assert.equal(early.searchParams.get('anchor'),'left-stair-1');
});

test('routed to another building, the event link room and indoor start stay behind',()=>{
  const event=new URLSearchParams({to:'DMC',room:'258',anchor:'left-stair-1',event:'AI@USC Showcase'});
  const ctx=vm.createContext({URLSearchParams,buildings,qs:event});
  const other=new URL(vm.runInContext(indoorHref+"\nindoorHref({building:'rtcc'},{building:'rtcc',indoor_node:'door'})",ctx),'http://test');
  assert.equal(other.searchParams.get('building'),'rtcc');assert.equal(other.searchParams.has('room'),false);
  assert.equal(other.searchParams.get('anchor'),'door');                     // its own door, not the event's stair
  const home=new URL(vm.runInContext("indoorHref({building:'"+B.id+"'})",ctx),'http://test');
  assert.equal(home.searchParams.get('room'),'258');assert.equal(home.searchParams.get('anchor'),'left-stair-1');
  assert.equal(vm.runInContext("atEvent('rtcc')",ctx),false);assert.equal(vm.runInContext("atEvent('"+B.id+"')",ctx),true);
});

test('Indoor View floats at the map top-right without changing its handoff URL',()=>{
  assert.match(html,/<div id="map"[^>]*>\s*<a id="indoorView" class="btnlink indoor-view" href="\/indoor\/">Indoor View<\/a>\s*<\/div>/);
  const css=html.slice(html.indexOf('<style>'),html.indexOf('</style>')).replace(/\s+/g,''); // the rules, however they are wrapped
  assert.match(css,/\.indoor-view\{position:absolute;top:max\(12px,env\(safe-area-inset-top\)\);right:max\(12px,env\(safe-area-inset-right\)\)/);
  assert.match(css,/@media\(max-width:480px\)\{\.indoor-view\{min-height:48px/);
  assert.match(css,/#map\.maphint\{top:max\(78px/);
  assert.match(html,/L\.DomEvent\.disableClickPropagation\(\$\('indoorView'\)\)/);
  const sandbox=vm.createContext({URLSearchParams,qs:new URLSearchParams({room:'258'})});
  const url=new URL(vm.runInContext(indoorHref+"\nindoorHref({building:'DMC'})",sandbox),'http://test');
  assert.equal(url.searchParams.get('room'),'258');assert.equal(url.searchParams.get('building'),'DMC');
  assert.equal(url.searchParams.has('anchor'),false);assert.equal(url.searchParams.has('entrance'),false);
});

test('the indoor link keeps its parameters on browsers without URLSearchParams.size (Safari before 17)',()=>{
  class Old extends URLSearchParams{get size(){return undefined;}}
  const sandbox=vm.createContext({URLSearchParams:Old,qs:new Old({room:'258'})});
  assert.equal(vm.runInContext(indoorHref+"\nindoorHref({building:'DMC'})",sandbox),'/indoor/?building=DMC&room=258');
  assert.equal(vm.runInContext("qs=new URLSearchParams();buildingId=()=>'';indoorHref()",sandbox),'/indoor/');
});

test('local preview serves the real API, the indoor viewer and its files, redirects and missing-file errors',async()=>{
  const server=createLocalServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    for(const path of ['/','/indoor/','/indoor/building.json','/indoor/scene/scene.json'])assert.equal((await fetch(base+path)).status,200,path);
    // Browsers refuse a module script that is not served as JavaScript; /indoor/ imports nav.mjs.
    assert.match((await fetch(base+'/indoor/nav.mjs')).headers.get('content-type'),/^text\/javascript/);
    assert.equal((await fetch(base+'/indoor',{redirect:'manual'})).status,308);
    assert.equal((await fetch(base+'/missing.js')).status,404);
    const head=await fetch(base+'/indoor/scene/entrance.glb',{method:'HEAD'});assert.equal(head.headers.get('content-type'),'model/gltf-binary');assert.equal((await head.arrayBuffer()).byteLength,0);
    assert.equal((await fetch(base+'/api/health').then(r=>r.json())).walking_routes,true);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('the destination list shows building codes, and a picked "Name (CODE)" still finds the building',()=>{
  const sandbox=vm.createContext({URLSearchParams,buildings,qs:new URLSearchParams()});
  vm.runInContext(indoorHref,sandbox);const run=code=>vm.runInContext(code,sandbox);
  assert.equal(run("bLabel(buildings[1])"),'Ronald Tutor Campus Center (TCC)');
  assert.equal(run("findId('Ronald Tutor Campus Center (TCC)')"),'rtcc');
  assert.equal(run("findId('(258) Ronald Tutor Campus Center (TCC)')"),'rtcc');   // a room prefix from an event link
  assert.equal(run("findId('tcc')"),'rtcc');
  assert.equal(run("findId('Ronald Tutor Campus Center')"),'rtcc');
  assert.equal(run("bLabel({name:'No Code Hall',aliases:[]})"),'No Code Hall');
});

test('a door with no indoor directions names the building doors that have them',async()=>{
  // DMC's west door is surveyed but not yet linked to the indoor map.
  const response=await worker.fetch(new Request('http://test/api/outdoor/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:{lat:34.02108,lon:-118.28468},to:'DMC'})}),{});
  const result=await response.json();assert.equal(result.ok,true);
  assert.equal(result.handoff.entrance_id,'dmc-west');assert.equal(result.handoff.indoor_node,null);
  assert.deepEqual(result.handoff.indoor_doors.map(d=>d.id).sort(),['dmc-breezeway-east','jmc-main']);
  const card=html.slice(html.indexOf("// \"Ronald Tutor"),html.indexOf("$('result').onclick"));
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const ctx=vm.createContext({URLSearchParams,buildings,qs:new URLSearchParams(),esc,EVENT:'',ROOM:'',ROOM_TEXT:'',summary:result.summary,handoff:result.handoff});
  const out=vm.runInContext(card+'\narrivalCard(summary,handoff)',ctx);
  assert.match(out,/No indoor directions from this door yet\. They start from <b>Main entrance/);assert.doesNotMatch(out,/not set up for this building/);
  // A linked door gets no list, and a building with no indoor map keeps the old line.
  const main=await (await worker.fetch(new Request('http://test/api/outdoor/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:{lat:34.0215019,lon:-118.2840557},to:'DMC'})}),{})).json();
  assert.deepEqual(main.handoff.indoor_doors,[]);
  assert.match(vm.runInContext("arrivalCard({building:'x',building_name:'X'},{building:'x',indoor_doors:[]})",ctx),/not set up for this building yet/);
});
