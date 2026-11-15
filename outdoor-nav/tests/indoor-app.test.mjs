// Exercise the real page controller and real routing, with only the GPU renderer replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {startApp} from '../outdoor/static/indoor/app.js';

const json=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const venue=json('../outdoor/static/indoor/data/venue.json');
const graph=json('../outdoor/static/indoor/data/graph.json');

class Element {
  constructor(){this.children=[];this.listeners={};this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.attributes={};this.dataset={};this.classes=new Set();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name)};}
  append(...elements){this.children.push(...elements);}
  replaceChildren(...elements){this.children=elements;}
  addEventListener(name,callback){(this.listeners[name]||=[]).push(callback);}
  setAttribute(name,value){this.attributes[name]=value;}
  removeAttribute(name){delete this.attributes[name];}
  fire(name){for(const callback of this.listeners[name]||[])callback({target:this});}
}

async function page(search,check,{modelFailure=false,venueData=venue}={}) {
  const originals=Object.fromEntries(['document','location','window','fetch'].map(key=>[key,globalThis[key]]));
  const html=readFileSync(new URL('../outdoor/static/indoor/index.html',import.meta.url),'utf8');
  const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){
    elements[match[1]].hidden=/\shidden\b/.test(match[0]);
    elements[match[1]].disabled=/\sdisabled\b/.test(match[0]);
  }
  const floors=[1,2].map(floor=>{const element=new Element();element.dataset.floor=String(floor);return element;});
  const calls={loaded:0,route:null,disposed:0,view:'map',progress:0,floor:2};let onProgress;
  const emit=()=>onProgress({distance:calls.progress*(calls.route?.length||0),length:calls.route?.length||0,playing:!!calls.playing,view:calls.view,floor:calls.floor});
  const viewer={ready:modelFailure?null:Promise.resolve(),setRoute(route){calls.route=route;calls.view='walk';emit();},setMapFloor(floor){calls.floor=floor;emit();},setProgress(value){calls.progress=value;emit();},setView(view){calls.view=view;emit();},togglePlay(){calls.playing=!calls.playing;emit();},clearRoute(){calls.route=null;},dispose(){calls.disposed++;}};
  globalThis.document={getElementById:id=>elements[id],createElement:()=>new Element(),querySelectorAll:selector=>selector==='[data-floor]'?floors:[]};
  globalThis.location={search};globalThis.window={addEventListener(){}};
  globalThis.fetch=async path=>({ok:true,json:async()=>path.endsWith('venue.json')?venueData:graph});
  try {
    await startApp({loadViewer:async()=>{calls.loaded++;return {createViewer(_canvas,_venue,callback){onProgress=callback;if(modelFailure)viewer.ready=Promise.reject(new Error('Model load failed.'));return viewer;}};}});
    await check({elements,calls,floors});
  }finally{for(const [key,value] of Object.entries(originals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
}

test('page automatically routes the confirmed handoff to the explicit Demo Room and wires controls',async()=>{
  await page('?building=JMC&entrance=jmc-main&anchor=entrance&room=258',({elements:e,calls,floors})=>{
    assert.equal(e.selection.hidden,true);assert.equal(e.route.hidden,false);assert.equal(e.loading.hidden,true);
    assert.equal(e['start-select'].disabled,true);assert.equal(e['dest-select'].disabled,true);
    assert.equal(e['dest-select'].value,'258');
    assert.ok(e['dest-select'].children.some(option=>option.value==='258'&&option.textContent==='Room 258'));
    assert.equal(calls.route.startNodeId,19150);assert.equal(calls.route.destinationNodeId,23822);
    assert.equal(calls.route.nodePoints.at(-1)[1],3.7);
    assert.ok(calls.route.steps.some(step=>step.text.includes('stairs up')));
    assert.match(e.status.textContent,/not a real room/);assert.match(e['route-title'].textContent,/Room 258/);
    assert.ok(e.steps.children.length);assert.match(e.back.href,/room=258/);
    e.pos.value='500';e.pos.fire('input');assert.equal(calls.progress,0.5);
    e['btn-map'].fire('click');assert.equal(calls.view,'map');assert.equal(e.floors.hidden,false);
    floors[0].fire('click');assert.equal(calls.floor,1);
    e['btn-play'].fire('click');assert.equal(calls.playing,true);
    e['btn-change'].fire('click');assert.equal(e.selection.hidden,false);assert.equal(e['dest-select'].value,'258');
  });
});

test('page requires manual selection when parameters are missing and keeps the event destination locked',async()=>{
  await page('?building=JMC&room=258',({elements:e,calls})=>{
    assert.equal(calls.route,null);assert.equal(e['start-route'].disabled,true);assert.equal(e['dest-select'].disabled,true);
    e['start-select'].value=venue.anchors[1].id;e['start-select'].fire('change');assert.equal(e['start-route'].disabled,false);
    e['start-route'].fire('click');assert.ok(calls.route);assert.equal(calls.route.destinationNodeId,23822);
  });
});

test('unknown rooms stop before viewer startup and retain the incoming event room',async()=>{
  await page('?building=JMC&entrance=jmc-main&anchor=entrance&room=room_205',({elements:e,calls})=>{
    assert.equal(calls.loaded,0);assert.equal(calls.route,null);assert.equal(e.selection.hidden,true);
    assert.match(e.status.textContent,/no verified indoor mapping/);assert.match(e.back.href,/room=room_205/);
    assert.equal(e['sample-link'].hidden,false);assert.match(e.status.textContent,/room_205/);
  });
});

test('model failures leave navigation disabled and show a recoverable error',async()=>{
  await page('?building=JMC&entrance=jmc-main&anchor=entrance&room=258',({elements:e,calls})=>{
    assert.equal(calls.route,null);assert.equal(calls.disposed,1);assert.equal(e['start-route'].disabled,true);
    assert.equal(e.loading.hidden,false);assert.match(e.status.textContent,/Model load failed/);
  },{modelFailure:true});
});
