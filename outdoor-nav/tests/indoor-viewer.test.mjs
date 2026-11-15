// Run the real M1 module with a GPU boundary double. This is not browser/render QA.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRouting} from '../outdoor/static/indoor/routing.js';
import {buildRouteGeometry,sampleRoute} from '../outdoor/static/indoor/route-geometry.js';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const venue=JSON.parse(read('../outdoor/static/indoor/data/venue.json'));
const routing=createRouting(JSON.parse(read('../outdoor/static/indoor/data/graph.json')));

function environment({width=800,height=500,coarse=false,dpr=1,modelFailure=false}={}) {
  const state={renderers:[],geometries:[],cameras:[],controls:[],renders:0,delta:.1};
  class Vector {
    constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
    set(x,y,z){Object.assign(this,{x,y,z});return this;}
    fromArray(a){return this.set(...a);}
    copy(v){return this.set(v.x,v.y,v.z);}
    normalize(){const length=Math.hypot(this.x,this.y,this.z)||1;return this.set(this.x/length,this.y/length,this.z/length);}
    addScaledVector(v,s){return this.set(this.x+v.x*s,this.y+v.y*s,this.z+v.z*s);}
    project(){return this;}
    setScalar(s){return this.set(s,s,s);}
  }
  class Node {
    constructor(){this.children=[];this.position=new Vector();this.scale=new Vector(1,1,1);this.rotation=new Vector();this.userData={};this.visible=true;this.name='';}
    add(...nodes){this.children.push(...nodes);}
    remove(node){this.children=this.children.filter(item=>item!==node);}
    traverse(callback){callback(this);for(const node of this.children)node.traverse(callback);}
    lookAt(){}
    updateMatrixWorld(){}
  }
  class Camera extends Node {constructor(...args){super();this.fov=args[0];this.aspect=args[1];state.cameras.push(this);}updateProjectionMatrix(){}}
  class Material {constructor(properties={}){Object.assign(this,properties);}}
  class Mesh extends Node {constructor(geometry,material){super();this.geometry=geometry;this.material=material;this.isMesh=true;}}
  class Geometry {constructor(){this.attributes={};state.geometries.push(this);}setAttribute(key,value){this.attributes[key]=value;}setIndex(value){this.indices=value;}dispose(){this.disposed=true;}}
  class Renderer {
    constructor(options){state.renderers.push(this);this.options=options;this.capabilities={getMaxAnisotropy:()=>8};}
    setPixelRatio(value){this.pixelRatio=value;}setSize(width,height){this.size=[width,height];}render(){state.renders++;}setAnimationLoop(callback){this.frame=callback;}dispose(){this.disposed=true;}
  }
  class Texture {constructor(){this.offset={y:0};}}
  class Controls {constructor(){this.target=new Vector();state.controls.push(this);}update(){}dispose(){}}
  const model=new Node();const floor1=new Mesh({},new Material({color:'#fff'}));floor1.name='F1_Entrance_lobby';
  const floor2=new Mesh({},new Material({color:'#fff'}));floor2.name='F2_Left_hallway';model.add(floor1,floor2);
  class Loader {setMeshoptDecoder(value){state.decoder=value;}load(path,callback,onProgress,onError){state.modelPath=path;queueMicrotask(()=>{onProgress?.({loaded:100,total:200,lengthComputable:true});if(modelFailure)onError(new Error('network'));else callback({scene:model});});}}
  const drawing={fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},roundRect(){},fill(){},fillText(){}};
  const listeners={};
  const canvas={clientWidth:width,clientHeight:height,addEventListener(name,callback){(listeners[name]||=[]).push(callback);},setPointerCapture(id){state.captured=id;},fire(name,event={}){for(const callback of listeners[name]||[])callback(event);}};
  const THREE={TOUCH:{ROTATE:0,DOLLY_PAN:2},WebGLRenderer:Renderer,Scene:Node,Group:Node,Color:Material,HemisphereLight:Node,DirectionalLight:Node,PerspectiveCamera:Camera,CanvasTexture:Texture,MeshBasicMaterial:Material,MeshLambertMaterial:Material,SpriteMaterial:Material,Mesh,Sprite:Node,Vector3:Vector,BufferGeometry:Geometry,Float32BufferAttribute:class{constructor(array){this.array=array;}},RingGeometry:Geometry,CylinderGeometry:Geometry,SphereGeometry:Geometry,Clock:class{getDelta(){return state.delta;}},DoubleSide:2};
  const document={hidden:false,documentElement:{},createElement:()=>({getContext:()=>drawing})};
  const context=vm.createContext({THREE,buildRouteGeometry,sampleRoute,GLTFLoader:Loader,OrbitControls:Controls,MeshoptDecoder:{},devicePixelRatio:dpr,document,getComputedStyle:()=>({getPropertyValue:name=>name==='--ground'?'#f6f5f2':'#08734d'}),matchMedia:()=>({matches:coarse}),ResizeObserver:class{observe(){}disconnect(){}},queueMicrotask});
  const source=read('../outdoor/static/indoor/viewer.js').replace(/^import .*;\r?$/gm,'').replace('export function createViewer','function createViewer');
  vm.runInContext(source,context);
  return {createViewer:vm.runInContext('createViewer',context),canvas,state,document,floor1,floor2};
}

test('M1 accepts M3 world coordinates, applies route lift once, and supports camera/progress controls',async()=>{
  const env=environment(),updates=[];const viewer=env.createViewer(env.canvas,venue,state=>updates.push(state));await viewer.ready;
  assert.equal(env.state.modelPath,'./models/web.glb');
  viewer.setMapFloor(1);assert.equal(env.floor1.visible,true);assert.equal(env.floor2.visible,false);
  const route=routing.findRoute(routing.snap(venue.anchors[0]),23822);viewer.setRoute(route);
  assert.equal(updates.at(-1).view,'walk');assert.equal(env.floor2.visible,true);
  const ribbon=env.state.geometries.find(geometry=>geometry.attributes.position);
  assert.ok(ribbon);assert.ok(ribbon.attributes.position.array.length>0);
  const positions=ribbon.attributes.position.array;assert.ok(Math.abs(positions[1]-route.pts[0][1]-.07)<1e-8);
  assert.ok(Math.abs((positions[0]+positions[9])/2-route.pts[0][0])<1e-8);
  assert.ok(Math.abs((positions[2]+positions[11])/2-route.pts[0][2])<1e-8);
  viewer.setProgress(.5);assert.equal(updates.at(-1).distance,route.length/2);
  viewer.togglePlay();env.state.renderers[0].frame();assert.ok(updates.at(-1).distance>route.length/2);
  viewer.setView('map');assert.equal(updates.at(-1).playing,false);assert.equal(updates.at(-1).view,'map');
  viewer.setProgress(1);assert.equal(updates.at(-1).distance,route.length);
  viewer.setView('walk');env.state.renderers[0].frame();
  assert.ok(Math.abs(env.state.cameras[0].position.y-(3.7+1.55))<1e-10);
  const node=routing.snap(venue.anchors[0]);viewer.setRoute(routing.findRoute(node,node));viewer.togglePlay();assert.equal(updates.at(-1).length,0);
  viewer.clearRoute();viewer.dispose();assert.equal(env.state.renderers[0].frame,null);assert.equal(env.state.renderers[0].disposed,true);
});

test('mobile viewport profiles cap GPU resolution and keep Meshopt/model loading configured',async()=>{
  for(const [width,height] of [[320,568],[390,844],[412,915],[844,390]]) {
    const env=environment({width,height,coarse:true,dpr:3}),loads=[];
    const viewer=env.createViewer(env.canvas,venue,()=>{},{onLoadProgress:value=>loads.push(value)});await viewer.ready;
    const renderer=env.state.renderers[0];assert.equal(renderer.pixelRatio,1.5);assert.equal(renderer.options.antialias,false);assert.equal(renderer.options.powerPreference,'low-power');
    assert.deepEqual(renderer.size,[width,height]);assert.ok(env.state.decoder);assert.equal(loads[0].loaded,100);assert.equal(loads[0].total,200);
    assert.equal(env.state.controls[0].touches.ONE,0);assert.equal(env.state.controls[0].touches.TWO,2);
    viewer.dispose();
  }
});

test('Walk touch tracking ignores other fingers and resets on pointer cancellation',async()=>{
  const env=environment({coarse:true}),viewer=env.createViewer(env.canvas,venue);await viewer.ready;
  viewer.setRoute(routing.findRoute(19150,23822));const renderer=env.state.renderers[0],camera=env.state.cameras[0];renderer.frame();const initial=camera.rotation.y;
  env.canvas.fire('pointerdown',{pointerId:1,clientX:10,clientY:10,isPrimary:true});assert.equal(env.state.captured,1);
  env.canvas.fire('pointerdown',{pointerId:2,clientX:500,clientY:500,isPrimary:false});
  env.canvas.fire('pointermove',{pointerId:2,clientX:900,clientY:500});renderer.frame();assert.equal(camera.rotation.y,initial);
  env.canvas.fire('pointermove',{pointerId:1,clientX:30,clientY:10});renderer.frame();assert.ok(Math.abs(camera.rotation.y-initial-.1)<1e-10);
  env.canvas.fire('pointercancel',{pointerId:1});const after=camera.rotation.y;
  env.canvas.fire('pointermove',{pointerId:1,clientX:80,clientY:10});renderer.frame();assert.equal(camera.rotation.y,after);viewer.dispose();
});

test('mobile frame budget, hidden pages and WebGL loss pause rendering without moving progress',async()=>{
  const env=environment({coarse:true}),updates=[],viewer=env.createViewer(env.canvas,venue,state=>updates.push(state));await viewer.ready;
  viewer.setRoute(routing.findRoute(19150,23822));env.state.delta=1/120;const renderer=env.state.renderers[0],before=env.state.renders;
  for(let i=0;i<120;i++)renderer.frame();assert.ok(env.state.renders-before<=30);
  viewer.togglePlay();env.document.hidden=true;const s=updates.at(-1).distance,count=env.state.renders;
  for(let i=0;i<120;i++)renderer.frame();assert.equal(env.state.renders,count);assert.equal(updates.at(-1).distance,s);
  env.document.hidden=false;let prevented=false;env.canvas.fire('webglcontextlost',{preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(updates.at(-1).contextLost,true);assert.equal(updates.at(-1).playing,false);
  renderer.frame();assert.equal(env.state.renders,count);env.canvas.fire('webglcontextrestored');assert.equal(updates.at(-1).contextLost,false);viewer.dispose();
});

test('GLB network/decode failure rejects readiness with a recoverable message',async()=>{
  const env=environment({coarse:true,modelFailure:true}),viewer=env.createViewer(env.canvas,venue);
  await assert.rejects(viewer.ready,/model did not load/);viewer.dispose();
});

test('mobile CSS provides touch-sized controls, safe-area spacing and landscape layout',()=>{
  const css=read('../outdoor/static/indoor/indoor.css');
  assert.match(css,/input,select\{font-size:16px\}/);assert.match(css,/#pos\{min-height:44px/);
  assert.match(css,/height:100dvh/);assert.match(css,/safe-area-inset-left/);assert.match(css,/orientation:landscape/);
});
