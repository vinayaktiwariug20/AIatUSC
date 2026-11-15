import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRouting} from '../outdoor/static/indoor/routing.js';
import {readContext,resolveSelection,outdoorLink} from '../outdoor/static/indoor/context.js';
import worker from '../cloudflare/worker.mjs';
import {createLocalServer} from '../tools/dev-indoor.mjs';
import {createDijkstraOracle} from './helpers/indoor-dijkstra.mjs';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const graph=JSON.parse(read('../outdoor/static/indoor/data/graph.json'));
const venue=JSON.parse(read('../outdoor/static/indoor/data/venue.json'));
const routing=createRouting(graph);
const reference=JSON.parse(read('./fixtures/indoor-reference.json'));
const oracle=createDijkstraOracle(graph);

test('extracted NAV and GLB match the recorded original Sample hashes',()=>{
  const hash=value=>createHash('sha256').update(value).digest('hex');
  assert.equal(hash(JSON.stringify(graph)),reference.navSha256);
  assert.equal(hash(readFileSync(new URL('../outdoor/static/indoor/models/web.glb',import.meta.url))),reference.modelSha256);
});

test('all twelve Sample routes match independent Dijkstra 3D distances and render exact graph edges',()=>{
  for(const expected of reference.routes){
    const anchor=venue.anchors[expected.anchor],destination=venue.destinations[expected.destination];
    const start=routing.snap(anchor),end=routing.snap(destination),route=routing.findRoute(start,end);
    assert.ok(route);assert.deepEqual(route.nodePoints[0],routing.point(start));assert.deepEqual(route.nodePoints.at(-1),routing.point(end));
    const shortest=oracle.solve(start,end);
    assert.ok(Math.abs(route.length-shortest.distance)<1e-8);
    assert.deepEqual(route.pts,route.nodePoints); // no off-graph smoothing or shortcuts
    for(let i=1;i<route.nodeIds.length;i++)assert.ok(oracle.adjacency[route.nodeIds[i-1]].some(edge=>edge.to===route.nodeIds[i]));
    assert.ok(routing.isTraversable(route.pts));assert.ok(route.length>0);
    assert.equal(route.cum.length,route.pts.length);assert.equal(route.cum.at(-1),route.length);
    assert.ok(route.pts.every(p=>p.every(Number.isFinite)));
    assert.ok(route.steps.every(step=>step.start>=0));
  }
});

test('routing handles same-node arrival, unreachable components and invalid inputs',()=>{
  const node=routing.snap(venue.anchors[0]),route=routing.findRoute(node,node);
  assert.equal(route.length,0);assert.equal(route.steps.at(-1).start,0);assert.ok(route.pts.length>=2);
  for(const bad of [-1,graph.count,NaN,'0'])assert.throws(()=>routing.findRoute(bad,node),/node ID/);
  assert.throws(()=>routing.snap({floor:1,pos:[999,999]}),/outside/);
  assert.throws(()=>createRouting({...graph,nodes:''}),/node data/);
  const bytes=Buffer.alloc(16);[0,0,0,8,2,0,0,8].forEach((v,i)=>bytes.writeInt16LE(v,i*2));
  const disconnectedGraph={x0:0,z0:0,nx:3,nz:1,cell:0.15,count:2,floorH:3.7,nodes:bytes.toString('base64')};
  const disconnected=createRouting(disconnectedGraph);
  assert.equal(disconnected.findRoute(0,1),null);
  assert.equal(createDijkstraOracle(disconnectedGraph).solve(0,1),null);
});

test('confirmed entrance is mapped, unverified entries require selection, and unknown rooms are refused',()=>{
  const context=readContext('?building=JMC&entrance=jmc-main&anchor=entrance',venue);
  assert.equal(context.start.id,venue.anchors[0].id);assert.equal(context.destination,null);assert.ok(context.warnings.length);
  assert.equal(venue.entrances['jmc-main'].verified,true);assert.deepEqual(venue.rooms,{});
  const unverified=structuredClone(venue);unverified.entrances['jmc-main'].verified=false;
  assert.equal(readContext('?entrance=jmc-main&anchor=entrance',unverified).start,null);
  assert.throws(()=>readContext('?building=JMC&room=room_205',venue),/no verified indoor mapping/);
  assert.throws(()=>readContext('?building=other',venue),/JMC only/);
  assert.throws(()=>readContext('?entrance=unknown',venue),/not registered/);
  assert.throws(()=>readContext('?entrance=jmc-main&anchor=sample-left-side-door',venue),/do not match/);
  assert.throws(()=>readContext('?room=a&room=b',venue),/Duplicate/);
  assert.throws(()=>readContext('?room=__proto__',venue),/no verified/);
});

test('event-link selections take precedence, survive reload, and remain in the return link',()=>{
  const search='?building=JMC&anchor='+venue.anchors[0].id+'&room='+venue.destinations[0].id;
  const context=readContext(search,venue);
  const selected=resolveSelection(context,{anchorId:venue.anchors[1].id,destinationId:venue.destinations[1].id},venue,routing);
  assert.equal(selected.start.id,venue.anchors[0].id);assert.equal(selected.destination.id,venue.destinations[0].id);
  assert.deepEqual(readContext(search,venue),context);
  const back=new URL(outdoorLink(search,venue),'http://test');assert.equal(back.searchParams.get('room'),venue.destinations[0].id);
  assert.throws(()=>resolveSelection(readContext('',venue),{},venue,routing),/Choose/);
});

test('unchanged Outdoor arrival link automatically resolves the confirmed door and Demo Room',async()=>{
  const event=new URL('https://example.test/?to=JMC&room=258');
  const response=await worker.fetch(new Request('http://test/api/outdoor/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:{lat:34.0215019,lon:-118.2840557},to:event.searchParams.get('to')})}),{});
  const result=await response.json();assert.equal(result.ok,true);assert.equal(result.handoff.indoor_node,'entrance');
  const html=read('../outdoor/static/index.html');const card=html.slice(html.indexOf('function indoorHref('),html.indexOf('function updateIndoorView('));
  const esc=html.split('\n').find(line=>line.startsWith('const esc='));
  const sandbox=vm.createContext({URLSearchParams,qs:event.searchParams,summary:result.summary,handoff:result.handoff});
  const href=vm.runInContext(esc+'\n'+card+'\nindoorHref(summary,handoff)',sandbox);
  const context=readContext(new URL(href,'http://test').search,venue);
  assert.equal(context.raw.entrance,'jmc-main');assert.equal(context.raw.anchor,'entrance');assert.equal(context.destination.id,'258');assert.equal(context.start.id,venue.anchors[0].id);
  const selected=resolveSelection(context,{},venue,routing);
  assert.equal(selected.destination.name,'Room 258');assert.equal(selected.raw.room,'258');
  assert.equal(selected.startSource,'handoff');assert.equal(selected.destinationSource,'event-link');
  const route=routing.findRoute(selected.startNodeId,selected.destinationNodeId);
  assert.ok(route.length>100&&route.length<150);assert.equal(selected.destinationNodeId,23822);assert.equal(selected.destination.floor,2);assert.equal(selected.destination.isRealRoom,false);assert.equal(selected.sample,true);
  assert.deepEqual(route.nodePoints.at(-1),[16.975,3.7,1.0249999999999986]);
  assert.ok(route.nodePoints.some(point=>point[1]>.3&&point[1]<3.4));
  assert.ok(route.steps.some(step=>step.text==='Take the stairs up to floor 2'));
  assert.ok(Math.abs(route.length-oracle.solve(selected.startNodeId,selected.destinationNodeId).distance)<1e-8);
});

test('Indoor View uses a map control without changing its handoff URL',()=>{
  const html=read('../outdoor/static/index.html');
  assert.match(html,/L\.control\(\{position:'topright'\}\)/);
  assert.match(html,/link\.id='indoorView';link\.href='\/indoor\/'/);
  assert.match(html,/\.leaflet-control\.indoor-view\{/);
  assert.match(html,/@media\(max-width:480px\)\{\s*\.indoor-view\{min-height:48px/);
  assert.match(html,/#map \.maphint\{top:max\(78px/);
  assert.match(html,/L\.DomEvent\.disableClickPropagation\(link\)/);
  const helper=html.slice(html.indexOf('function indoorHref('),html.indexOf('function updateIndoorView('));
  const sandbox=vm.createContext({URLSearchParams,qs:new URLSearchParams({room:'258'})});
  const url=new URL(vm.runInContext(helper+"\nindoorHref({building:'JMC'})",sandbox),'http://test');
  assert.equal(url.searchParams.get('room'),'258');assert.equal(url.searchParams.get('building'),'JMC');
  assert.equal(url.searchParams.has('anchor'),false);assert.equal(url.searchParams.has('entrance'),false);
});

test('all configured routes, reverse stairs and 24 deterministic node pairs match Dijkstra',()=>{
  const pairs=[];
  for(const anchor of venue.anchors)for(const destination of venue.destinations)pairs.push([routing.snap(anchor),routing.snap(destination)]);
  pairs.push([23822,19150],[10566,19150],[19150,19150]);
  let seed=20261114;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%graph.count;};
  for(let i=0;i<24;i++)pairs.push([next(),next()]);
  for(const [start,end] of pairs){
    const actual=routing.findRoute(start,end),expected=oracle.solve(start,end);
    if(!expected){assert.equal(actual,null);continue;}
    assert.ok(actual);assert.ok(Math.abs(actual.length-expected.distance)<1e-8,`${start}->${end}`);
    assert.equal(actual.cum.at(-1),actual.length);
  }
});

test('distance objective has no wall penalty and counts true diagonal and vertical metres',()=>{
  const makeGrid=(nx,nz,height,clearance)=>{
    const bytes=Buffer.alloc(nx*nz*8);
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++)[i,j,Math.round(height(i,j)*100),clearance(i,j)].forEach((v,c)=>bytes.writeInt16LE(v,(j*nx+i)*8+c*2));
    return {x0:0,z0:0,nx,nz,cell:.15,count:nx*nz,floorH:3.7,nodes:bytes.toString('base64')};
  };
  const flat=makeGrid(7,5,()=>0,(i,j)=>j===2&&i>0&&i<6?4:32);
  const flatRouting=createRouting(flat),direct=flatRouting.findRoute(14,20);
  assert.ok(Math.abs(direct.length-.9)<1e-12);assert.deepEqual(direct.nodeIds,[14,15,16,17,18,19,20]);
  const diagonal=flatRouting.findRoute(0,8);assert.ok(Math.abs(diagonal.length-Math.SQRT2*.15)<1e-12);
  const raised=makeGrid(9,3,(i,j)=>j===1?Math.min(i,8-i)*.2:0,()=>32);
  const raisedRoute=createRouting(raised).findRoute(9,17),reference=createDijkstraOracle(raised).solve(9,17);
  assert.ok(Math.abs(raisedRoute.length-reference.distance)<1e-12);
  assert.ok(raisedRoute.nodePoints.some(point=>point[2]!==.225));
  assert.ok(raisedRoute.length<8*Math.hypot(.15,.2)); // take a shorter flat detour, not the planar-shortest climb
});

test('Euclidean heuristic is consistent on NAV edges; diagonal stair corners remain traversable',()=>{
  const target=oracle.points[23822];
  const h=point=>Math.hypot(...point.map((v,i)=>target[i]-v));
  oracle.adjacency.forEach((edges,id)=>{for(const edge of edges)assert.ok(h(oracle.points[id])<=edge.distance+h(oracle.points[edge.to])+1e-10);});
  assert.ok(routing.isTraversable([[46.675,3.28,-37.825],[46.525,3.6,-37.675]]));
  assert.equal(routing.isTraversable([[999,0,999],[1000,0,1000]]),false);
});

test('local preview serves the real API, indoor assets, redirects and missing-file errors',async()=>{
  const server=createLocalServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    for(const path of ['/','/indoor/','/indoor/app.js','/indoor/data/graph.json','/indoor/models/web.glb'])assert.equal((await fetch(base+path)).status,200,path);
    assert.equal((await fetch(base+'/indoor',{redirect:'manual'})).status,308);
    assert.equal((await fetch(base+'/missing.js')).status,404);
    const head=await fetch(base+'/indoor/models/web.glb',{method:'HEAD'});assert.equal(head.headers.get('content-type'),'model/gltf-binary');assert.equal((await head.arrayBuffer()).byteLength,0);
    assert.equal((await fetch(base+'/api/health').then(r=>r.json())).walking_routes,true);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
