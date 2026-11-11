import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createUpdateClient} from '../frontend/js/updates.js';
test('startup runs once without blocking and manual overlap shares request',async()=>{
 let resolve,calls=0,notices=0;const states=[];
 const client=createUpdateClient(cmd=>{assert.equal(cmd,'update_check');calls++;return new Promise(r=>resolve=r)},()=>notices++);
 client.version('1.0.0');const stop=client.subscribe(s=>states.push(s));assert.equal(client.startup(),undefined);client.startup();const pending=client.check();await Promise.resolve();assert.equal(calls,1);assert.equal(states.at(-1).checking,true);
 resolve({status:'available',currentVersion:'1.0.0',latestVersion:'1.1.0'});await pending;await Promise.resolve();assert.equal(notices,1);assert.equal(states.at(-1).checking,false);stop();
});
test('startup errors are quiet, manual retry works and browser target accepts no URL',async()=>{
 let calls=0,notices=0;const commands=[];const client=createUpdateClient(async(...args)=>{commands.push(args);if(args[0]==='update_open')return;if(++calls===1)throw Error('检查更新超时');return{status:'current',currentVersion:'1.0.0',latestVersion:'1.0.0'};},()=>notices++);
 client.startup();const error=await client.check();assert.equal(error.status,'error');assert.equal(notices,0);assert.match(error.error,/超时/);assert.equal((await client.check()).status,'current');await client.open();assert.deepEqual(commands.at(-1),['update_open']);
});
test('release version, compatibility and remote-window IPC policy stay aligned',()=>{
 const config=JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8')),pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const cargo=fs.readFileSync(new URL('../src-tauri/Cargo.toml',import.meta.url),'utf8');assert.equal(config.version,pkg.version);assert.match(cargo,new RegExp('version = "'+pkg.version.replaceAll('.','\\.')+'"'));assert.equal(config.bundle.windows.allowDowngrades,true);assert.equal(config.identifier,'cn.lepaopoju.desktop.dev');assert.equal(config.mainBinaryName,'budao-lepao');
 const android=JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.android.conf.json',import.meta.url),'utf8'));assert.equal(android.version,pkg.version);assert.equal(android.identifier,'com.poju.budaolepao');assert.equal(android.bundle.android.versionCode,1001005);
 const main=fs.readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');assert.ok(main.indexOf('ipc_policy::allowed')<main.indexOf('updates::update_check,'));assert.match(main,/updates::update_open,/);
 const settings=fs.readFileSync(new URL('../frontend/js/views/settings.js',import.meta.url),'utf8');assert.ok(!/不道乐跑 \d+\.\d+\.\d+/.test(settings));assert.match(settings,/s\.version/);
 const nsi=fs.readFileSync(new URL('../src-tauri/installer-template.nsi',import.meta.url),'utf8');assert.match(nsi,/\$R0 == -1\s+SendMessage \$R3 \$\{BM_SETCHECK\} \$\{BST_CHECKED\}/);
});
