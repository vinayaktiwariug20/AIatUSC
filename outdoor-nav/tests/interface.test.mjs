import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
// Run the actual page script and real API, with DOM/Leaflet test doubles and a
// synthetic driving provider. This tests transitions, not browser rendering.
const html=readFileSync(new URL('../outdoor/static/index.html',import.meta.url),'utf8');
const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
function element(id){let markup='',value='';return{id,checked:false,hidden:false,disabled:false,textContent:'',style:{},classList:{toggle(){}},setAttribute(){},get options(){return [...markup.matchAll(/<option value="([^"]*)"/g)].map(m=>({value:m[1]}));},get innerHTML(){return markup;},set innerHTML(v){markup=v;if(this.options.length)value=this.options[0].value;},get value(){return value;},set value(v){value=v;},async click(){return this.onclick?.({target:this});}};}
const layer=()=>({addTo(){return this;},bindTooltip(){return this;},remove(){return this;},clearLayers(){},getBounds(){return{};},setLatLng(p){this.point=p;return this;},getLatLng(){return this.point||{lat:34.02,lng:-118.287};}});
test('page sends driving mode, then switches to walking from the selected pedestrian exit; public reports are available',async()=>{
 const db=new DatabaseSync(':memory:');for(const f of ['0001_closures.sql','0002_mobility.sql'])db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const DB={prepare(sql){let params=[];return{bind(...p){params=p;return this;},async first(column){const row=db.prepare(sql).get(...params);return row?column?row[column]:row:null;},async run(){return db.prepare(sql).run(...params);}};}};
 const env={DB,ORS_API_KEY:'fake-provider-test-key',PUBLIC_REPORTS_ENABLED:'true'},elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],element(m[1])])),calls=[];
 const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>{const c=JSON.parse(options.body).coordinates;return new Response(JSON.stringify({features:[{type:'Feature',geometry:{type:'LineString',coordinates:c},properties:{summary:{duration:240,distance:1200},segments:[]}}]}));};
 try{
  const sandbox={document:{getElementById:id=>elements[id]},location:{search:'?mode=driving&to=Doheny&at=34.027,-118.2871694'},URLSearchParams,URL,AbortController,Date,console,localStorage:{removeItem(){}},window:{addEventListener(){}},navigator:{geolocation:{clearWatch(){}}},setInterval(){},
   L:{map(){return{setView(){return this;},on(){},fitBounds(){},distance(){return 20;}};},tileLayer:layer,layerGroup:layer,circleMarker:layer,circle:layer,polygon:layer,marker:layer,geoJSON:layer},
   fetch:async(path,options={})=>{if(options.body)calls.push(JSON.parse(options.body));return worker.fetch(new Request('https://app.test'+path,options),env);}};
  await vm.runInNewContext(script,sandbox);
  assert.equal(elements.repBtn.disabled,false);assert.equal(elements.driveOptions.hidden,false);
  elements.parking.value='downey';await elements.goBtn.click();
  assert.equal(calls.at(-1).mode,'driving');assert.equal(elements.parkedBtn.hidden,false);assert.match(elements.result.innerHTML,/Downey/);
  await elements.parkedBtn.click();assert.equal(calls.at(-1).mode,'walking');assert.equal(calls.at(-1).from.exit,'DOWNEY.ped.main');assert.equal(calls.at(-1).from.place,'downey');assert.equal(elements.driveOptions.hidden,true);assert.equal(elements.parkedBtn.hidden,true);assert.match(elements.result.innerHTML,/pedestrian exit/);
 }finally{globalThis.fetch=original;db.close();}
});
