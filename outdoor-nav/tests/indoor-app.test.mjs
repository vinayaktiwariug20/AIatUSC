// Exercise the deployed page and real routing, with only browser/graphics doubles.
// This checks behavior, not visual rendering.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as navigation from '../outdoor/static/indoor/nav.mjs';
const read=name=>readFileSync(new URL('../outdoor/static/indoor/'+name,import.meta.url),'utf8');
const html=read('index.html');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .+ from ['"].+['"];\s*$/gm,'');

class Element {
  constructor(){this.children=[];this.listeners={};this.value='';this.hidden=false;this.textContent='';this.attributes={};this.dataset={};this.style={};this.classes=new Set();this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),contains:n=>this.classes.has(n)};this.clientWidth=0;this.clientHeight=0;}
  append(...elements){for(const e of elements){e.parentElement=this;this.children.push(e);}}
  replaceChildren(...elements){this.children=[];this.append(...elements);}
  addEventListener(name,callback){(this.listeners[name]||=[]).push(callback);}
  setAttribute(name,value){this.attributes[name]=value;}
  fire(name){for(const callback of this.listeners[name]||[])callback({target:this});}
  click(){this.fire('click');}
  focus(){}
  getContext(){return {fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){}};}
}
function graphics({modelFailure=false}={}) {
  class Vector {
    constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
    set(x,y,z=0){Object.assign(this,{x,y,z});return this;}
    copy(v){return this.set(v.x,v.y,v.z);}
    clone(){return new Vector().copy(this);}
    add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this;}
    sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this;}
    multiplyScalar(s){this.x*=s;this.y*=s;this.z*=s;return this;}
    addScaledVector(v,s){return this.add(v.clone().multiplyScalar(s));}
    lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z;}
    length(){return Math.sqrt(this.lengthSq());}
    normalize(){return this.multiplyScalar(1/(this.length()||1));}
    dot(v){return this.x*v.x+this.y*v.y+this.z*v.z;}
    distanceTo(v){return this.clone().sub(v).length();}
    lerp(v,t){return this.multiplyScalar(1-t).addScaledVector(v,t);}
    setScalar(v){return this.set(v,v,v);}
  }
  class Node {
    constructor(){this.children=[];this.position=new Vector();this.scale=new Vector(1,1,1);this.up=new Vector(0,1,0);this.visible=true;}
    add(...nodes){this.children.push(...nodes);}
    remove(node){this.children=this.children.filter(n=>n!==node);}
    lookAt(){}
    updateProjectionMatrix(){}
    updateMatrixWorld(){}
  }
  class Material{constructor(options){Object.assign(this,options);}}
  class Geometry{setFromPoints(){return this;}setAttribute(){return this;}setIndex(){return this;}clone(){return new Geometry();}dispose(){}}
  class Mesh extends Node{constructor(geometry,material){super();this.geometry=geometry;this.material=material;}}
  class Color{setRGB(){return this;}}
  class Texture{constructor(){this.offset={x:0,y:0};}}
  class Camera extends Node{constructor(fov){super();this.fov=fov;this.aspect=1;}}
  class Controls{constructor(){this.target=new Vector();}update(){}}
  class Renderer{setPixelRatio(){}setSize(){}render(){}}
  class Curve {
    constructor(points){this.points=points;}
    getLength(){return this.points.slice(1).reduce((sum,p,i)=>sum+p.distanceTo(this.points[i]),0);}
    getPointAt(t,out){return out.copy(this.points[0]).lerp(this.points.at(-1),t);}
    getTangentAt(_t,out){return out.copy(this.points.at(-1)).sub(this.points[0]).normalize();}
  }
  class Loader{async loadAsync(){if(modelFailure)throw new Error('Model load failed.');return {scene:{children:[]}};}}
  return {THREE:{Vector2:Vector,Vector3:Vector,Group:Node,Scene:Node,Color,PerspectiveCamera:Camera,
    WebGLRenderer:Renderer,HemisphereLight:Node,DirectionalLight:Node,Mesh,Sprite:Node,Line:Mesh,
    MeshBasicMaterial:Material,MeshLambertMaterial:Material,SpriteMaterial:Material,LineBasicMaterial:Material,
    BoxGeometry:Geometry,BufferGeometry:Geometry,Float32BufferAttribute:class{},CanvasTexture:Texture,
    CatmullRomCurve3:Curve,Raycaster:class{},MathUtils:{degToRad:x=>x*Math.PI/180,radToDeg:x=>x*180/Math.PI,clamp:(x,a,b)=>Math.min(b,Math.max(a,x))}},OrbitControls:Controls,GLTFLoader:Loader};
}
async function page(search,check,options={}) {
  const elements=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  for(const m of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))elements[m[1]].hidden=/\shidden\b/.test(m[0]);
  elements.loadBar.parentElement=new Element();
  const floors=[1,2,0].map(f=>{const e=new Element();e.dataset.floor=String(f);return e;});
  const window={},body=new Element();
  const sandbox={...navigation,...graphics(options),window,document:{body,
    getElementById:id=>{assert.ok(elements[id],'Page is missing #'+id);return elements[id];},
    createElement:()=>new Element(),querySelectorAll:selector=>selector==='.seg button'?floors:[]},
    location:{search},URLSearchParams,devicePixelRatio:1,navigator:{userAgent:'test'},performance:{now:()=>0},
    ResizeObserver:class{observe(){}},requestAnimationFrame(){},addEventListener(){},
    console:{error(){}},fetch:async path=>({ok:true,json:async()=>JSON.parse(read(path))})};
  await vm.runInNewContext('(async()=>{'+script+'\n})()',sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  await check({elements,floors,app:window.__indoor,body});
}
test('current indoor page applies a mapped handoff and wires preview and floor controls',async()=>{
  await page('?building=JMC&entrance=jmc-main&anchor=entrance&room=middle-stair-2',({elements:e,floors,app})=>{
    assert.equal(e.vPick.hidden,true);assert.equal(e.vRoute.hidden,false);assert.equal(e.loading.hidden,true);
    assert.equal(app.ends.from.id,'entrance');assert.equal(app.ends.to.id,'middle-stair-2');
    assert.equal(app.route.points[0].id,'ent_front');assert.equal(app.route.points.at(-1).floor,2);
    assert.ok(e.steps.children.some(step=>step.textContent.includes('up to floor 2')));
    floors[1].click();assert.equal(floors[1].attributes['aria-pressed'],'true');
    e.walkBtn.click();assert.equal(e.vWalk.hidden,false);assert.ok(app.walk);
    e.wPlay.click();assert.equal(app.walk.playing,false);
    e.wSeek.value='500';e.wSeek.fire('input');assert.equal(app.walk.s,app.walk.length/2);
    e.wExit.click();assert.equal(app.walk,null);assert.equal(e.vRoute.hidden,false);
    assert.equal(new URL(e.back.href,'https://test').searchParams.get('room'),'middle-stair-2');
  });
});
test('current indoor page asks for a missing start and preserves the event destination',async()=>{
  await page('?building=JMC&room=middle-stair-2',({elements:e,app})=>{
    assert.equal(app.route,null);assert.equal(app.ends.from,null);assert.equal(app.ends.to.id,'middle-stair-2');
    assert.equal(e.vPick.hidden,false);assert.match(e.pickTitle.textContent,/Where are you now/);
    app.setEnd('from',app.building.places.find(p=>p.id==='entrance'));
    assert.ok(app.route);assert.equal(app.ends.to.id,'middle-stair-2');assert.equal(e.vRoute.hidden,false);
  });
});
test('current indoor page warns about an unmapped room without inventing a route or dropping the room',async()=>{
  await page('?building=JMC&anchor=entrance&room=room_205',({elements:e,app})=>{
    assert.equal(app.route,null);assert.equal(app.ends.to,null);assert.equal(e.notice.hidden,false);
    assert.match(e.notice.textContent,/room_205/);assert.match(e.notice.textContent,/not on this map yet/);
    assert.equal(e.vPick.hidden,false);assert.match(e.pickTitle.textContent,/Where are you going/);
    const back=new URL(e.back.href,'https://test');assert.equal(back.searchParams.get('room'),'room_205');assert.equal(back.searchParams.get('to'),'JMC');
  });
});
test('scan download failures finish loading with a visible warning and leave the route available',async()=>{
  await page('?building=JMC&anchor=entrance&room=middle-stair-2',({elements:e,app})=>{
    assert.equal(e.loading.hidden,true);assert.equal(e.more.hidden,true);assert.equal(e.notice.hidden,false);
    assert.match(e.notice.textContent,/parts of the building did not load/);assert.match(e.notice.textContent,/Routes still work/);
    assert.ok(app.route);assert.equal(e.walkBtn.hidden,false);
  },{modelFailure:true});
});
