#!/usr/bin/env node
// Apply this release to an existing checkout. Preserve Cloudflare bindings and
// secrets; back up every changed file before replacing anything.
import {readFile,writeFile,mkdir,rename,lstat,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const source=path.dirname(fileURLToPath(import.meta.url));
const destination=process.argv[2];
if(!destination){console.error('Usage: node apply-update.mjs /absolute/path/to/AIatUSC-main2');process.exit(1);}
const target=await realpath(path.resolve(destination));
if(target===await realpath(source)){console.error('Choose the existing project folder as the destination, not this extracted update folder.');process.exit(1);}
const hash=data=>createHash('sha256').update(data).digest('hex');
// Parse JSONC without executing code. Preserve strings while removing comments
// and trailing commas, then let JSON.parse validate the result.
function jsonc(text){let out='',string=false,escape=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(string){out+=c;if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}if(c==='"'){string=true;out+=c;}else if(c==='/'&&n==='/'){while(i<text.length&&text[i]!=='\n')i++;out+='\n';}else if(c==='/'&&n==='*'){i+=2;while(i<text.length&&!(text[i]==='*'&&text[i+1]==='/'))i++;i++;out+=' ';}else out+=c;}let cleaned='';string=false;escape=false;for(let i=0;i<out.length;i++){const c=out[i];if(string){cleaned+=c;if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}if(c==='"')string=true;if(c===','){let j=i+1;while(/\s/.test(out[j]||'')&&j<out.length)j++;if(out[j]==='}'||out[j]===']')continue;}cleaned+=c;}return JSON.parse(cleaned);}
const targetPackage=JSON.parse(await readFile(path.join(target,'package.json'),'utf8'));
if(targetPackage.name!=='aiatusc-cloudflare')throw new Error('This is not the AIatUSC Cloudflare project root. No files were changed.');
const manifest=JSON.parse(await readFile(path.join(source,'UPDATE_MANIFEST.json'),'utf8'));
const plan=[];
async function existing(relative){const segments=relative.split('/');for(let i=1;i<=segments.length;i++){const p=path.join(target,...segments.slice(0,i));try{if((await lstat(p)).isSymbolicLink())throw new Error('Refusing to replace symbolic link: '+relative);}catch(e){if(e.code!=='ENOENT')throw e;}}try{return await readFile(path.join(target,relative));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
for(const item of manifest.files){const relative=item.path;if(!/^[\w./-]+$/.test(relative)||relative.includes('..')||relative.startsWith('/')||relative==='outdoor-nav/wrangler.jsonc'||/^(\.git\/|node_modules\/)|(?:^|\/)\.dev\.vars$/.test(relative))throw new Error('Unsafe update path.');const data=await readFile(path.join(source,relative));if(hash(data)!==item.sha256)throw new Error('Update file checksum mismatch: '+relative);const before=await existing(relative);let after=data;if(relative==='package.json'){const incoming=JSON.parse(data);after=Buffer.from(JSON.stringify({...targetPackage,...incoming,scripts:{...targetPackage.scripts,...incoming.scripts},dependencies:{...targetPackage.dependencies,...incoming.dependencies},devDependencies:{...targetPackage.devDependencies,...incoming.devDependencies}},null,2)+'\n');}if(relative==='.gitignore'&&before){const lines=before.toString().split('\n'),append=data.toString().split('\n').filter(line=>line&&!lines.includes(line));after=append.length?Buffer.from(before.toString()+'\n'+append.join('\n')+'\n'):before;}if(before&&before.equals(after))continue;plan.push({relative,before,after});}
const configRelative='outdoor-nav/wrangler.jsonc',configBefore=await existing(configRelative);
if(!configBefore)throw new Error('Existing outdoor-nav/wrangler.jsonc is required. No files were changed.');
const config=jsonc(configBefore.toString());config.vars={...config.vars,PUBLIC_REPORTS_ENABLED:'true'};
const configAfter=Buffer.from(JSON.stringify(config,null,2)+'\n');if(!configBefore.equals(configAfter))plan.push({relative:configRelative,before:configBefore,after:configAfter});
if(!plan.length){console.log('This update is already applied.');process.exit(0);}
const tag=new Date().toISOString().replaceAll(':','-'),backup=path.join(target,'.aiatusc-update-backups',tag);
await mkdir(backup,{recursive:true});
for(const item of plan)if(item.before){const p=path.join(backup,item.relative);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,item.before);}
await writeFile(path.join(backup,'update-record.json'),JSON.stringify({created:new Date().toISOString(),files:plan.map(p=>({path:p.relative,was_new:p.before===null}))},null,2));
const applied=[];
try{for(const item of plan){const p=path.join(target,item.relative);await mkdir(path.dirname(p),{recursive:true});const temporary=p+'.aiatusc-update-tmp';await writeFile(temporary,item.after);await rename(temporary,p);applied.push(item);}}
catch(error){const {unlink}=await import('node:fs/promises');for(const item of applied.reverse()){const p=path.join(target,item.relative);if(item.before)await writeFile(p,item.before);else await unlink(p);}throw error;}
console.log(`Updated ${plan.length} files. Existing Cloudflare bindings were preserved.`);
console.log('PUBLIC_REPORTS_ENABLED is now true. Production changes apply after deployment.');
console.log('Backup: '+backup);
console.log('Next, in the existing project: npm run db:local; npm run db:remote; npm run secret:routing; npm test; npm run deploy');
