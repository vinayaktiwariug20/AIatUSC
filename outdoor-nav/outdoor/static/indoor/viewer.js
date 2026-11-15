// M1: reference Three.js scene, ribbon, camera and animation from indoor_demo/index.html.
import * as THREE from 'three';
import {buildRouteGeometry,sampleRoute} from './route-geometry.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';

export function createViewer(canvas, venue, onProgress = () => {}, {isWalkable,onLoadProgress=()=>{}} = {}) {
const css=getComputedStyle(document.documentElement);
const GROUND=css.getPropertyValue('--ground').trim(), ROUTE=css.getPropertyValue('--route').trim();
const BOUNDS=venue.bounds, FLOOR_TOP=venue.floorTop, EYE=1.55, SPEED=2.6, LIFT=0.07;
const mobile=matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({canvas,antialias:!mobile,powerPreference:mobile?'low-power':'default'});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1,mobile?1.5:2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(GROUND);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8f948c, 2.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(-30, 60, -45);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 900);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.maxPolarAngle = 1.45;
orbit.minDistance = 4;
orbit.maxDistance = 420;
orbit.touches={ONE:THREE.TOUCH.ROTATE,TWO:THREE.TOUCH.DOLLY_PAN};

// Depth testing prevents route graphics from showing through walls or other floors.
const solidMat=new THREE.MeshBasicMaterial({color:ROUTE,side:THREE.DoubleSide,depthTest:true,depthWrite:false});
const arrowMat=new THREE.MeshBasicMaterial({color:'#ffffff',side:THREE.DoubleSide,depthTest:true,depthWrite:false});
const routeGroup = new THREE.Group();
scene.add(routeGroup);

function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = ROUTE;
  g.beginPath(); g.roundRect(4, 4, 504, 120, 36); g.fill();
  g.fillStyle = '#FFFFFF';
  g.font = '600 60px "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.set(1.2, 0.3, 1);
  s.renderOrder = 8;
  return s;
}

// the event pin, and a dot for where you are on the map
const pinMat = new THREE.MeshBasicMaterial({ color: ROUTE, depthTest: false });
const marker = new THREE.Group();
{
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.44, 40), new THREE.MeshBasicMaterial({ color: ROUTE, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = LIFT + 0.01;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.7, 12), pinMat);
  stem.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), pinMat);
  head.position.y = 1.75;
  const label = labelSprite('Destination');
  label.position.y = 2.2;
  for (const m of [stem, head]) m.renderOrder = 7;
  marker.add(ring, stem, head, label);
  scene.add(marker);
}
const here = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: '#FFFFFF', depthTest: false }));
const hereCore = new THREE.Mesh(new THREE.SphereGeometry(0.68, 24, 16), new THREE.MeshBasicMaterial({ color: ROUTE, depthTest: false }));
here.renderOrder = 9; hereCore.renderOrder = 10;
here.add(hereCore);
here.visible = false;
scene.add(here);


let route=null, view='map', mapFloor=2, screen='pick', s=0, playing=false, yawOff=0, pitchOff=0,contextLost=false;
const upper=[];
function showUpper(on) { for (const mesh of upper) mesh.visible=on; }
marker.visible=false;
function clearRoute() {
  for(const mesh of [...routeGroup.children]){routeGroup.remove(mesh);mesh.geometry.dispose();}
}
function drawRoute() {
  clearRoute();
  const geometry=buildRouteGeometry(route,{halfWidth:view==='map'?.055:.045,lift:LIFT,isWalkable});
  for(const [data,material] of [[geometry.ribbon,solidMat],[geometry.arrows,arrowMat]]) {
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setIndex(data.indices);
    const mesh=new THREE.Mesh(g,material);mesh.renderOrder=6;routeGroup.add(mesh);
  }
}
function pointAt(distance) {return sampleRoute(route,distance).point;}

function sceneReady(gltf) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    const photo = src.emissiveMap || src.map;
    if (photo) {
      photo.anisotropy = Math.min(mobile?2:8, maxAniso);
      o.material = new THREE.MeshBasicMaterial({ map: photo });          // scans carry their own lighting in the photos
    } else if (src.emissive && src.emissive.getHex() !== 0) {
      o.material = new THREE.MeshBasicMaterial({ color: src.emissive });  // flat floor fill, matched to the scanned floor
    } else {
      o.material = new THREE.MeshLambertMaterial({ color: src.color });   // solid blocks take the scene light
    }
    if (o.name.startsWith('F2_')) upper.push(o);
  });
  scene.add(gltf.scene);

}

function placeMap() {
  const portrait = camera.aspect < 1;
  const top = FLOOR_TOP[mapFloor];
  showUpper(mapFloor === 2);
  const target = new THREE.Vector3((BOUNDS.x0 + BOUNDS.x1) / 2, top / 2, (BOUNDS.z0 + BOUNDS.z1) / 2);
  const dir = (portrait ? new THREE.Vector3(-0.75, 1.0, -0.12) : new THREE.Vector3(0.3, 0.8, -0.85)).normalize();
  const corners = [];
  for (const x of [BOUNDS.x0, BOUNDS.x1]) for (const y of [0, top]) for (const z of [BOUNDS.z0, BOUNDS.z1]) corners.push(new THREE.Vector3(x, y, z));
  const hiEdge = screen === 'pick' ? 0.5 : 0.78;          // leave room for the event card
  const v = new THREE.Vector3();
  camera.fov = 40;
  camera.updateProjectionMatrix();
  for (let d = 20; d <= 400; d += 2) {
    camera.position.copy(target).addScaledVector(dir, d);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    if (corners.every((c) => { v.copy(c).project(camera); return Math.abs(v.x) <= 0.94 && v.y <= hiEdge && v.y >= -0.86; })) break;
  }
  orbit.target.copy(target);
  orbit.update();
}


function placeWalk() {
  const p = pointAt(s), ahead = pointAt(Math.min(s + 2.5, route.length));
  let dir = [ahead[0] - p[0], ahead[2] - p[2]], rise = ahead[1] - p[1];
  if (Math.hypot(dir[0], dir[1]) < 0.3) { const q = pointAt(s - 1.5); dir = [p[0] - q[0], p[2] - q[2]]; rise = 0; }
  const tilt = Math.atan2(rise, Math.hypot(dir[0], dir[1]) || 1) * 0.6;
  camera.position.set(p[0], p[1] + EYE, p[2]);
  camera.rotation.set(-0.1 + tilt + pitchOff, Math.atan2(-dir[0], -dir[1]) + yawOff, 0, 'YXZ');
}


function refresh() {
  if(!route){onProgress({distance:0,length:0,playing:false,view,floor:mapFloor,contextLost});return;}
  const p=pointAt(s); here.position.set(p[0],p[1]+1.2,p[2]);
  onProgress({distance:s,length:route.length,playing,view,floor:mapFloor,contextLost});
}
function setMapFloor(f) {
  if(![1,2].includes(f)) throw new Error('Unknown floor.');
  mapFloor=f;showUpper(f===2);if(view==='map')placeMap();refresh();
}
function setView(next) {
  if(!['walk','map'].includes(next))throw new Error('Unknown view.');
  view=next;const walk=view==='walk'; orbit.enabled=!walk;
  here.visible=!!route&&!walk;marker.scale.setScalar(walk?1:3.2);
  if(route)drawRoute();
  if(walk&&route){showUpper(true);camera.fov=72;camera.updateProjectionMatrix();placeWalk();}
  else {playing=false;if(route)mapFloor=pointAt(s)[1]>FLOOR_TOP[1]?2:1;placeMap();}
  refresh();
}
function resize() {
  const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
  renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
  if(view==='map')placeMap();
}
const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
const loader=new GLTFLoader();loader.setMeshoptDecoder(MeshoptDecoder);
const ready=new Promise((resolve,reject)=>loader.load(venue.model,gltf=>{try{sceneReady(gltf);showUpper(mapFloor===2);placeMap();resolve();}catch(error){reject(error);}},event=>onLoadProgress({loaded:event.loaded,total:event.lengthComputable?event.total:0}),()=>reject(new Error('The JMC building model did not load. Check your connection and reload to try again.'))));
let drag=null;
canvas.addEventListener('pointerdown',e=>{if(route&&view==='walk'&&!drag&&e.isPrimary!==false){drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture?.(e.pointerId);}});
canvas.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;yawOff+=(e.clientX-drag.x)*0.005;pitchOff=Math.max(-0.7,Math.min(0.7,pitchOff+(e.clientY-drag.y)*0.004));drag={id:drag.id,x:e.clientX,y:e.clientY};});
for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,e=>{if(drag&&e.pointerId===drag.id)drag=null;});
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();contextLost=true;playing=false;drag=null;refresh();});
canvas.addEventListener('webglcontextrestored',()=>{contextLost=false;clock.getDelta();resize();refresh();});
const clock=new THREE.Clock();
let elapsed=0;
renderer.setAnimationLoop(()=>{const delta=Math.min(clock.getDelta(),0.1);
  if(document.hidden||contextLost){elapsed=0;return;}
  elapsed+=delta;if(mobile&&elapsed<1/30)return;const dt=elapsed;elapsed=0;
  if(route&&view==='walk'){if(playing){s=Math.min(s+dt*SPEED,route.length);if(s>=route.length)playing=false;refresh();}placeWalk();}else orbit.update();
  renderer.render(scene,camera);
});
return {ready,setView,setMapFloor,
  setRoute(next) {
    if(!next?.pts?.length||next.pts.some(p=>p.length!==3||!p.every(Number.isFinite))||!Number.isFinite(next.length))throw new Error('Invalid route.');
    route=next;s=0;playing=false;yawOff=pitchOff=0;screen='route';marker.visible=true;
    marker.position.fromArray(route.pts.at(-1));setView('walk');
  },
  clearRoute(){route=null;playing=false;screen='pick';clearRoute();marker.visible=here.visible=false;setView('map');},
  setProgress(fraction){if(!route)return;playing=false;s=Math.max(0,Math.min(1,fraction))*route.length;refresh();},
  togglePlay(){if(contextLost||!route||!route.length)return;if(view!=='walk')setView('walk');if(s>=route.length)s=0;playing=!playing;refresh();},
  dispose(){renderer.setAnimationLoop(null);observer.disconnect();clearRoute();orbit.dispose();renderer.dispose();}
};
}
