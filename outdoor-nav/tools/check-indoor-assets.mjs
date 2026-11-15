// CI guard for the exact static tree Wrangler deploys. No network or deployment.
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
assert.ok(['auto-trailing-slash','force-trailing-slash'].includes(config.assets.html_handling||'auto-trailing-slash'),'Indoor relative HTML URLs require canonical directory paths.');
assert.notEqual(config.assets.not_found_handling,'single-page-application','Missing JS/GLB must return 404, not Outdoor HTML.');
const origin='https://assets.example.test',page=new URL('/indoor/',origin),checked=new Set();

function asset(reference,base=page) {
  const url=new URL(reference,base);
  assert.equal(url.origin,origin,'Building resources must be served from this deployment.');
  const segments=decodeURIComponent(url.pathname).split('/').filter(Boolean);
  let file=root;
  for(const segment of segments){assert.ok(readdirSync(file).includes(segment),'Missing asset or case mismatch: '+url.pathname);file=resolve(file,segment);}
  assert.ok(file.startsWith(root+sep));assert.ok(statSync(file).isFile(),'Asset is not a file: '+url.pathname);
  assert.ok(statSync(file).size<=25*1024*1024,'Asset exceeds the Workers Static Assets 25 MiB limit.');
  checked.add(url.pathname);return {file,url};
}

const html=readFileSync(asset('./index.html').file,'utf8');
for(const match of html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"[^>]*>/g))asset(match[1]);
const importMap=JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/)[1]).imports;
for(const value of Object.values(importMap))assert.ok(value.startsWith('https://')&&value.includes('three@0.180.0/'),'Three.js must use the existing pinned HTTPS version.');

function modules(source,base) {
  assert.ok(!/localhost|127\.0\.0\.1|file:\/\/|dev-indoor\.mjs/.test(source),'Production code references a local development environment.');
  for(const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
    const specifier=match[1];
    if(specifier.startsWith('.')||specifier.startsWith('/'))asset(specifier,base);
    else assert.ok(Object.keys(importMap).some(key=>key.endsWith('/')?specifier.startsWith(key):specifier===key),'Unmapped browser import: '+specifier);
  }
}
for(const block of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
  modules(block[1],page);
  const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:block[1],encoding:'utf8'});
  assert.equal(result.status,0,result.error?.message||result.stderr);
}
for(const name of readdirSync(indoor).filter(name=>extname(name)==='.js')) {
  const {file,url}=asset(name);modules(readFileSync(file,'utf8'),url);
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(result.status,0,result.error?.message||result.stderr);
}
const venue=JSON.parse(readFileSync(asset('./data/venue.json').file,'utf8'));
const graph=JSON.parse(readFileSync(asset('./data/graph.json').file,'utf8'));
assert.equal(Buffer.from(graph.nodes,'base64').length,graph.count*8);
const model=readFileSync(asset(venue.model).file);
assert.equal(model.subarray(0,4).toString(),'glTF');assert.equal(model.readUInt32LE(4),2);assert.equal(model.readUInt32LE(8),model.length);
const gltf=JSON.parse(model.subarray(20,20+model.readUInt32LE(12)).toString());
for(const item of [...gltf.buffers,...gltf.images])if(item.uri&&!item.uri.startsWith('data:'))asset(item.uri,new URL(venue.model,page));
assert.ok(venue.destinations.some(destination=>destination.id==='258'&&destination.isRealRoom===false));
// Local helper scripts sit outside the asset root; they are never client dependencies.
assert.ok(!existsSync(resolve(root,'tools/dev-indoor.mjs')));
console.log(`Indoor deployment assets OK: ${checked.size} resources; GLB ${model.length} bytes; all browser modules pass syntax/import checks.`);
