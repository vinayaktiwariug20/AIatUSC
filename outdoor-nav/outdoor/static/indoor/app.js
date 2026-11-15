// M2 composition: existing Outdoor hyperlink -> M4 context -> M3 routing -> M1 viewer.
import {readContext, resolveSelection, outdoorLink} from './context.js';
import {createRouting} from './routing.js';

export async function startApp({loadViewer = () => import('./viewer.js')} = {}) {
  const $ = id => document.getElementById(id);
  const json = async path => { const response = await fetch(path); if (!response.ok) throw new Error('Could not load indoor navigation data.'); return response.json(); };
  const [venue, graph] = await Promise.all([json('./data/venue.json'), json('./data/graph.json')]);
  $('back').href = outdoorLink(location.search, venue);
  let context;
  try { context=readContext(location.search,venue); }
  catch(error) {
    $('status').textContent=error.message;$('status').classList.add('error');
    $('loading').textContent='No route selected.';$('floors').hidden=true;$('sample-link').hidden=false;
    return;
  }
  const routing=createRouting(graph);
  for(const [id,items] of [['start-select',venue.anchors],['dest-select',venue.destinations]]) {
    for(const item of items) { const option=document.createElement('option');option.value=item.id;option.textContent=item.name;$(id).append(option); }
  }
  if(context.start){$('start-select').value=context.start.id;$('start-select').disabled=true;}
  if(context.destination){$('dest-select').value=context.destination.id;$('dest-select').disabled=true;}
  $('selection').hidden=false;
  $('status').textContent='Choose your location while the building loads.';
  let viewer, currentRoute=null, loaded=false, viewerInterrupted=false, routeStatus='';
  const updateStart=()=>{$('start-route').disabled=!loaded||viewerInterrupted||!$('start-select').value||!$('dest-select').value;};
  $('start-select').addEventListener('change',updateStart);$('dest-select').addEventListener('change',updateStart);
  function progress(state) {
    $('pos').value=state.length?String(Math.round(state.distance/state.length*1000)):'0';
    $('pos-out').textContent=Math.round(state.distance)+' of '+Math.round(state.length)+' m';
    $('btn-play').textContent=state.playing?'Pause':state.distance>=state.length?'Replay':'Play';
    $('btn-play').disabled=state.length===0||!!state.contextLost;
    for(const id of ['btn-walk','btn-map','pos'])$(id).disabled=!!state.contextLost;
    if(state.contextLost){viewerInterrupted=true;$('status').textContent='The 3D view was interrupted. Waiting for graphics to recover; reload if needed.';$('status').classList.add('error');}
    else if(viewerInterrupted){viewerInterrupted=false;$('status').textContent=routeStatus||'Choose your start and destination to navigate.';$('status').classList.remove('error');}
    updateStart();
    $('btn-walk').setAttribute('aria-pressed',String(state.view==='walk'));
    $('btn-map').setAttribute('aria-pressed',String(state.view==='map'));
    $('floors').hidden=state.view==='walk';
    document.querySelectorAll('[data-floor]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.floor)===state.floor)));
    let active=0;currentRoute?.steps.forEach((step,i)=>{if(state.distance>=step.start-0.5)active=i;});
    [...$('steps').children].forEach((li,i)=>{if(i===active)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});
  }
  function navigate() {
    try {
      const selected=resolveSelection(context,{anchorId:$('start-select').value,destinationId:$('dest-select').value},venue,routing);
      const route=routing.findRoute(selected.startNodeId,selected.destinationNodeId);
      if(!route)throw new Error('No walkable route connects these locations. Choose another location or ask venue staff.');
      currentRoute=route;$('steps').replaceChildren();
      route.steps.forEach(step=>{const li=document.createElement('li');li.textContent=step.text;$('steps').append(li);});
      $('route-title').textContent='To '+selected.destination.name;
      $('route-sub').textContent='From '+selected.start.name+' · '+Math.round(route.length)+' m';
      $('status').classList.remove('error');
      $('status').textContent=selected.destination.kind==='demo'?'Demo route · Room 258 is a temporary test location, not a real room.':selected.sample?'Sample route · follow the model locations; this is not a verified room route.':'Your indoor route is ready.';
      routeStatus=$('status').textContent;
      $('selection').hidden=true;$('route').hidden=false;viewer.setRoute(route);
    } catch(error) {$('status').textContent=error.message;$('status').classList.add('error');}
  }
  $('start-route').addEventListener('click',navigate);
  $('btn-play').addEventListener('click',()=>viewer.togglePlay());
  $('pos').addEventListener('input',()=>viewer.setProgress(Number($('pos').value)/1000));
  $('btn-walk').addEventListener('click',()=>viewer.setView('walk'));
  $('btn-map').addEventListener('click',()=>viewer.setView('map'));
  document.querySelectorAll('[data-floor]').forEach(button=>button.addEventListener('click',()=>viewer.setMapFloor(Number(button.dataset.floor))));
  $('btn-change').addEventListener('click',()=>{viewer.clearRoute();currentRoute=null;$('selection').hidden=false;$('route').hidden=true;$('status').textContent='Review your locations. Event-link locations remain selected.';});
  try {
    const {createViewer}=await loadViewer();
    viewer=createViewer($('view'),venue,progress,{isWalkable:routing.isTraversable,onLoadProgress:({loaded,total})=>{
      $('loading').textContent=total&&loaded<total?'Loading the JMC building… '+Math.round(loaded/total*100)+'%':'Preparing the JMC 3D view…';
    }});await viewer.ready;loaded=true;
    $('loading').hidden=true;$('status').textContent='Choose your start and destination to navigate.';
    viewer.setMapFloor(context.destination?.floor||2);updateStart();
    if(context.start&&context.destination)navigate();
    window.addEventListener('pagehide',event=>{if(!event.persisted)viewer.dispose();});
  } catch(error) {
    viewer?.dispose();$('status').textContent=error.message;$('status').classList.add('error');
    $('loading').textContent='The viewer could not load. Check your connection and reload.';$('floors').hidden=true;
  }
}
