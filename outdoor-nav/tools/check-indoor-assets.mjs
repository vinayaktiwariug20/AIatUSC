// CI guard for the exact static tree Wrangler deploys. No network or deployment.
// The indoor viewer is outdoor/static/indoor/: index.html (served at /indoor/), nav.mjs, building.json and scene/.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

function parseJsonc(source) {
  let text='',quoted=false,escaped=false;
  for(let i=0;i<source.length;i++) {
    const char=source[i],next=source[i+1];
    if(quoted){text+=char;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"'){quoted=true;text+=char;continue;}
    if(char==='/'&&next==='/'){while(i<source.length&&source[i]!=='\n')i++;text+='\n';continue;}
    if(char==='/'&&next==='*'){i+=2;while(i<source.length&&!(source[i]==='*'&&source[i+1]==='/'))i++;i++;text+=' ';continue;}
    text+=char;
  }
  let result='';quoted=false;escaped=false;
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(quoted){result+=char;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"')quoted=true;
    if(char===','){let j=i+1;while(/\s/.test(text[j]||'')&&j<text.length)j++;if(text[j]==='}'||text[j]===']')continue;}
    result+=char;
  }
  return JSON.parse(result);
}

const outdoor=fileURLToPath(new URL('../',import.meta.url));
const config=parseJsonc(readFileSync(resolve(outdoor,'wrangler.jsonc'),'utf8'));
const root=resolve(outdoor,config.assets.directory),indoor=resolve(root,'indoor');
assert.equal(config.assets.binding,'ASSETS');
// index.html must be served at /indoor/ (with the slash) for its relative URLs to resolve.
assert.ok(['auto-trailing-slash','force-trailing-slash'].includes(config.assets.html_handling||'auto-trailing-slash'),'Indoor relative URLs require canonical directory paths.');
assert.notEqual(config.assets.not_found_handling,'single-page-application','Missing JS/GLB must return 404, not Outdoor HTML.');
const origin='https://assets.example.test',base=new URL('/indoor/',origin),checked=new Set();

function asset(reference,from=base) {
  const url=new URL(reference,from);
  assert.equal(url.origin,origin,'Building resources must be served from this deployment: '+reference);
  const segments=decodeURIComponent(url.pathname).split('/').filter(Boolean);
  let file=root;
  for(const segment of segments){assert.ok(readdirSync(file).includes(segment),'Missing asset or case mismatch: '+url.pathname);file=resolve(file,segment);}
  assert.ok(file.startsWith(root+sep));assert.ok(statSync(file).isFile(),'Asset is not a file: '+url.pathname);
  assert.ok(statSync(file).size<=25*1024*1024,'Asset exceeds the Workers Static Assets 25 MiB limit.');
  checked.add(url.pathname);return {file,url};
}

let importMap={};
function modules(source,from) {
  assert.ok(!/localhost|127\.0\.0\.1|file:\/\/|dev-indoor\.mjs/.test(source),'Production code references a local development environment.');
  // import/export ... from '…', import '…', and import('…'). Only statements: the word "from" in a comment or string is not an import.
  for(const match of source.matchAll(/(?:^|[;\n])\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier=match[1]||match[2]||match[3];
    if(specifier.startsWith('.')||specifier.startsWith('/'))asset(specifier,from);
    else assert.ok(Object.keys(importMap).some(key=>key.endsWith('/')?specifier.startsWith(key):specifier===key),'Unmapped browser import: '+specifier);
  }
}
function syntax(args,input) {
  const result=spawnSync(process.execPath,['--check',...args],{input,encoding:'utf8'});
  assert.equal(result.status,0,result.error?.message||result.stderr);
}

const html=readFileSync(asset('index.html').file,'utf8');
// Inline data: URLs (the empty favicon) carry their own content; everything else must be a file in this deployment.
for(const match of html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"[^>]*>/g))if(!match[1].startsWith('data:'))asset(match[1]);
importMap=JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/)[1]).imports;
for(const value of Object.values(importMap))assert.ok(value.startsWith('https://')&&value.includes('three@0.180.0/'),'Three.js must use the existing pinned HTTPS version.');
const blocks=[...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
assert.ok(blocks.length,'index.html has no module script.');
for(const block of blocks){modules(block[1],base);syntax(['--input-type=module'],block[1]);}
for(const name of readdirSync(indoor).filter(name=>['.js','.mjs'].includes(extname(name)))) {
  const {file,url}=asset(name);modules(readFileSync(file,'utf8'),url);syntax([file]);
}

// The building, its navigation graph, its rooms and the scanned scenes.
const building=JSON.parse(readFileSync(asset('./building.json').file,'utf8'));
assert.ok(building.places.length&&Object.keys(building.nav.nodes).length);
for(const place of building.places)assert.ok(building.nav.nodes[place.node],'Place points at a missing node: '+place.id);
for(const room of building.rooms)assert.ok(room.id&&(building.nav.nodes[room.node]||[room.x,room.z,room.floor].every(Number.isFinite)),'Room has no position: '+room.id);
const scene=JSON.parse(readFileSync(asset('./scene/scene.json').file,'utf8'));
for(const scan of scene.scans)assert.equal(statSync(asset('./scene/'+scan.file).file).size,scan.bytes,scan.file+' size differs from scene.json.');
// Local helper scripts sit outside the asset root; they are never client dependencies.
assert.ok(!existsSync(resolve(root,'tools/dev-indoor.mjs')));
console.log(`Indoor deployment assets OK: ${checked.size} resources; ${scene.scans.length} scans; ${building.rooms.length} room(s); all browser modules pass syntax/import checks.`);
