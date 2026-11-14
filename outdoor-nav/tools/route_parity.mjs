import {readFileSync} from 'node:fs';
import {WalkRouter,Unreachable} from '../cloudflare/router.mjs';
const router = new WalkRouter(JSON.parse(readFileSync(new URL('../cloudflare/graph.json',import.meta.url),'utf8')));
const cases = JSON.parse(readFileSync(0,'utf8'));
const output=cases.map(input=>{try{return {ok:true,...router.route(input)};}catch(e){if(e instanceof Unreachable)return {ok:false,blocked_by:e.blockedBy,choices:e.choices};throw e;}});
process.stdout.write(JSON.stringify(output));
