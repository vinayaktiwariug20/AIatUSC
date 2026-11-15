// Dependency-free local preview using the real, unchanged Cloudflare walking API.
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {resolve, sep, extname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import worker from '../cloudflare/worker.mjs';

const root=resolve(fileURLToPath(new URL('../outdoor/static/',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.glb':'model/gltf-binary','.jpg':'image/jpeg','.png':'image/png'};

export function createLocalServer() {
  const ASSETS={async fetch(request) {
    try {
      const url=new URL(request.url), pathname=decodeURIComponent(url.pathname);
      let file=resolve(root,'.'+pathname);
      if(file!==root&&!file.startsWith(root+sep))return new Response('Not found',{status:404});
      const info=await stat(file);
      if(info.isDirectory()) {
        if(!url.pathname.endsWith('/'))return new Response(null,{status:308,headers:{Location:url.pathname+'/'+url.search}});
        file=resolve(file,'index.html');
      }
      if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
      const data=await readFile(file);
      return new Response(request.method==='HEAD'?null:data,{headers:{'Content-Type':types[extname(file)]||'application/octet-stream','Content-Length':String(data.length),'Cache-Control':'no-store'}});
    } catch {return new Response('Not found',{status:404});}
  }};
  return createServer(async(req,res)=>{
    try {
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>17000){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}
      const method=req.method||'GET';
      const request=new Request(new URL(req.url,'http://127.0.0.1'),{method,headers:req.headers,...(!['GET','HEAD'].includes(method)&&chunks.length?{body:Buffer.concat(chunks)}:{})});
      const response=await worker.fetch(request,{ASSETS});
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(500,{'Content-Type':'text/plain'});res.end('Local preview request failed.');}
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const index=process.argv.indexOf('--port');const port=index<0?8000:Number(process.argv[index+1]);
  const hostIndex=process.argv.indexOf('--host'),host=hostIndex<0?'127.0.0.1':process.argv[hostIndex+1];
  if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('Use --host 127.0.0.1 (default) or --host 0.0.0.0 for phone testing on your local network.');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Use --port with a value from 1 to 65535.');
  const server=createLocalServer();server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(port,host,()=>console.log(`DoorSteps local preview: http://127.0.0.1:${port}\n${host==='0.0.0.0'?'Phone testing: open http://<your-computer-LAN-IP>:'+port+' on the same Wi-Fi.\n':''}Walking API: real Cloudflare router, read-only; driving and persistent reports require the existing Wrangler/D1 setup.`));
}
