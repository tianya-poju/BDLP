import {fileURLToPath} from 'node:url';import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {api} from '../frontend/js/api.js';
const root=fileURLToPath(new URL('../frontend/',import.meta.url));
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
test('all visible API calls resolve to actual implemented functions',()=>{
 for(const file of files(root).filter(f=>f.endsWith('.js'))){const source=fs.readFileSync(file,'utf8');for(const match of source.matchAll(/\bapi\.([a-zA-Z_]\w*)\s*\(/g))assert.equal(typeof api[match[1]],'function',`${file}: api.${match[1]}`);}
});
test('uninstall template never recursively deletes legacy AppData',()=>{
 const s=fs.readFileSync(new URL('../src-tauri/installer-template.nsi',import.meta.url),'utf8');assert.doesNotMatch(s,/RmDir\s+\/r\s+"\$(?:LOCAL)?APPDATA/i);assert.match(s,/Software\\lepaopoju\\不道乐跑（开发预览）/);
});
