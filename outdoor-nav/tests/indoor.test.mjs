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
const indoorHref=html.slice(html.indexOf('function indoorHref('),html.indexOf('function updateIndoorView('));

test('the event link reaches the indoor viewer with a door and a room it knows, and a route between them',async()=>{
  const event=new URL('https://example.test/?to=JMC&room=258');
  const response=await worker.fetch(new Request('http://test/api/outdoor/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:{lat:34.0215019,lon:-118.2840557},to:event.searchParams.get('to')})}),{});
  const result=await response.json();assert.equal(result.ok,true);assert.equal(result.handoff.indoor_node,'entrance');
  const sandbox=vm.createContext({URLSearchParams,qs:event.searchParams,summary:result.summary,handoff:result.handoff});
  const link=new URL(vm.runInContext(indoorHref+'\nindoorHref(summary,handoff)',sandbox),'http://test');
  assert.equal(link.pathname,'/indoor/');
  assert.equal(link.searchParams.get('building'),B.id);assert.equal(link.searchParams.get('entrance'),'jmc-main');
  const from=findPlace(B,link.searchParams.get('anchor')),to=findPlace(B,link.searchParams.get('room'));
  assert.equal(from.id,'entrance');assert.equal(to.id,'258');
  const r=route(B.nav,placeEnd(B,from),placeEnd(B,to));
  assert.ok(r);assert.equal(r.points.at(-1).floor,2);
});

test('Indoor View floats at the map top-right without changing its handoff URL',()=>{
  assert.match(html,/<div id="map"[^>]*>\s*<a id="indoorView" class="btnlink indoor-view" href="\/indoor\/">Indoor View<\/a>\s*<\/div>/);
  const css=html.slice(html.indexOf('<style>'),html.indexOf('</style>')).replace(/\s+/g,''); // the rules, however they are wrapped
  assert.match(css,/\.indoor-view\{position:absolute;top:max\(12px,env\(safe-area-inset-top\)\);right:max\(12px,env\(safe-area-inset-right\)\)/);
  assert.match(css,/@media\(max-width:480px\)\{\.indoor-view\{min-height:48px/);
  assert.match(css,/#map\.maphint\{top:max\(78px/);
  assert.match(html,/L\.DomEvent\.disableClickPropagation\(\$\('indoorView'\)\)/);
  const sandbox=vm.createContext({URLSearchParams,qs:new URLSearchParams({room:'258'})});
  const url=new URL(vm.runInContext(indoorHref+"\nindoorHref({building:'JMC'})",sandbox),'http://test');
  assert.equal(url.searchParams.get('room'),'258');assert.equal(url.searchParams.get('building'),'JMC');
  assert.equal(url.searchParams.has('anchor'),false);assert.equal(url.searchParams.has('entrance'),false);
});

test('the indoor link keeps its parameters on browsers without URLSearchParams.size (Safari before 17)',()=>{
  class Old extends URLSearchParams{get size(){return undefined;}}
  const sandbox=vm.createContext({URLSearchParams:Old,qs:new Old({room:'258'})});
  assert.equal(vm.runInContext(indoorHref+"\nindoorHref({building:'JMC'})",sandbox),'/indoor/?building=JMC&room=258');
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
