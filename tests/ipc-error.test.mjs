import test from 'node:test';
import assert from 'node:assert/strict';
import {invoke} from '../frontend/js/ipc.js';
test('IPC preserves typed errors and broadcasts only explicit authentication expiry',async()=>{
 const events=[];globalThis.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options.detail;}};
 globalThis.window={dispatchEvent:e=>events.push(e),__TAURI__:{core:{invoke:async()=>{throw{kind:'network',message:'登录失效文字不决定分类',code:'timeout'}}}}};
 await assert.rejects(invoke('read'),e=>e.kind==='network'&&e.code==='timeout');assert.equal(events.length,0);
 window.__TAURI__.core.invoke=async()=>{throw{kind:'auth_expired',message:'请重新授权',code:'101'}};
 await assert.rejects(invoke('read'),e=>e.kind==='auth_expired');assert.equal(events.length,1);assert.equal(events[0].type,'account-expired');
 window.__TAURI__.core.invoke=async()=>{throw '{"kind":"auth_expired"}'};
 await assert.rejects(invoke('read'),e=>e.kind==='business');assert.equal(events.length,1);delete globalThis.window;delete globalThis.CustomEvent;
});
