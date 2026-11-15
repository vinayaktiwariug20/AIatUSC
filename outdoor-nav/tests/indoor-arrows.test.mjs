import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRouting} from '../outdoor/static/indoor/routing.js';
import {buildRouteGeometry,sampleRoute} from '../outdoor/static/indoor/route-geometry.js';
const json=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const venue=json('../outdoor/static/indoor/data/venue.json'),routing=createRouting(json('../outdoor/static/indoor/data/graph.json'));

test('rigid arrows point forward on straight, reverse and stair segments and skip tight bends',()=>{
  for(const pts of [[[0,0,0],[0,0,4]],[[0,0,4],[0,0,0]],[[0,0,0],[0,2,4]]]) {
    const length=Math.hypot(...pts[1].map((v,i)=>v-pts[0][i])),route={pts,cum:[0,length],length};
    const output=buildRouteGeometry(route);assert.ok(output.placements.length);
    for(const arrow of output.placements){const delta=pts[1].map((v,i)=>v-pts[0][i]);assert.ok(delta.reduce((sum,v,i)=>sum+v*arrow.tangent[i],0)>0);assert.equal(arrow.length,.48);}
  }
  const turn={pts:[[0,0,0],[0,0,1],[1,0,1]],cum:[0,1,2],length:2};
  const geometry=buildRouteGeometry(turn,{spacing:.1});
  assert.ok(geometry.placements.every(arrow=>Math.abs(arrow.distance-1)>.24));
  assert.deepEqual(sampleRoute(turn,1.5).point,[.5,0,1]);
});

test('all Sample overlays stay inside NAV footprints and preserve shortest route geometry',()=>{
  let arrowCount=0;
  for(const anchor of venue.anchors)for(const destination of venue.destinations) {
    const route=routing.findRoute(routing.snap(anchor),routing.snap(destination));
    const original=JSON.stringify(route.pts),length=route.length;
    const overlay=buildRouteGeometry(route,{isWalkable:routing.isTraversable});
    assert.equal(JSON.stringify(route.pts),original);assert.equal(route.length,length);
    arrowCount+=overlay.placements.length;
    for(const arrow of overlay.placements){const before=sampleRoute(route,arrow.distance-.24).point,after=sampleRoute(route,arrow.distance+.24).point;assert.ok(after.reduce((sum,v,i)=>sum+(v-before[i])*arrow.tangent[i],0)>0);assert.ok(arrow.halfWidth<=.06);}
    for(const [data,lift] of [[overlay.ribbon,.07],[overlay.arrows,.076]])for(let i=0;i<data.positions.length;i+=12) {
      const floor=[];for(let j=0;j<12;j+=3)floor.push([data.positions[i+j],data.positions[i+j+1]-lift,data.positions[i+j+2]]);
      assert.ok(routing.isTraversable([...floor,floor[0]]));
    }
  }
  assert.ok(arrowCount>100);
});

test('route materials use depth testing and there is no through-wall ghost or warped UV texture',()=>{
  const source=readFileSync(new URL('../outdoor/static/indoor/viewer.js',import.meta.url),'utf8');
  for(const name of ['solidMat','arrowMat'])assert.match(source,new RegExp('const '+name+'=.*depthTest:true'));
  assert.equal(source.includes('ghostMat'),false);assert.equal(source.includes('routeTex'),false);
});
