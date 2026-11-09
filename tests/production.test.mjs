import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {Worker} from 'node:worker_threads';
const dir=fileURLToPath(new URL('../build/frontend/',import.meta.url));
function all(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?all(path.join(p,e.name)):[path.join(p,e.name)]);}
test('production assets exclude references and every relative module, worker and CSS image exists',()=>{
 for(const file of all(dir)){
  assert.doesNotMatch(file,/\.map$|runner\.js$|run-worker\.js$|leaflet|settings\.dpapi|node\.exe/);
  if(file.endsWith('.js'))for(const m of fs.readFileSync(file,'utf8').matchAll(/(?:from\s*|import\s*|new URL\(\s*)["'](\.[^"']+)["']/g))assert.ok(fs.existsSync(path.resolve(path.dirname(file),m[1])),`${file}: ${m[1]}`);
  if(file.endsWith('.css'))for(const m of fs.readFileSync(file,'utf8').matchAll(/url\(["']?([^)'"\s]+)["']?\)/g))if(!m[1].startsWith('#')&&!m[1].includes(':'))assert.ok(fs.existsSync(path.resolve(path.dirname(file),m[1])),`${file}: ${m[1]}`);
 }
});
test('minified production Worker calculates a local preview with its full dependency graph',async()=>{
 const url=new URL('../build/frontend/js/preview-worker.js',import.meta.url);
 const src=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:v=>parentPort.postMessage(v)};await import(${JSON.stringify(url.href)});parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true});`;
 const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(src)));
 try{const r=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('timeout')),5000);w.on('error',reject);w.on('message',r=>{if(r.ready){w.postMessage({kind:'route',args:[[[28.07,112.99],[28.08,112.99],[28.08,113]]]});return;}clearTimeout(t);resolve(r);});});assert.equal(r.error,undefined);assert.equal(r.value.localOnly,true);assert.ok(r.value.distanceKm>0);}
 finally{await w.terminate();}
});
