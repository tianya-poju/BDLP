import test from 'node:test';
import assert from 'node:assert/strict';
test('registry restore coalesces events and ignores late reads and late listener registration after detach',async()=>{
 let event,finishRead,finishListen,calls=0,unlistens=0;const states=[];
 globalThis.window={__TAURI__:{core:{invoke:async cmd=>{assert.equal(cmd,'run_current');calls++;return new Promise(r=>finishRead=r);}},event:{listen:async(name,callback)=>{assert.equal(name,'job-updated');event=callback;return new Promise(r=>finishListen=r);}}}};
 const {subscribeCurrentRun}=await import('../frontend/js/run-client.js');const off=subscribeCurrentRun(s=>states.push(s));event();event();assert.equal(calls,1);finishRead({uid:'a',current:{id:'job'}});await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(states.length,1);
 off();finishRead({uid:'a',current:{id:'late'}});finishListen(()=>unlistens++);await new Promise(r=>setImmediate(r));assert.equal(states.length,1);assert.equal(unlistens,1);
});
test('detaching and returning restores accumulated progress without cancelling task',async()=>{
 let status={status:'running',logs:['准备','心跳'],result:{}};let cancels=0;
 globalThis.window={__TAURI__:{core:{invoke:async cmd=>{if(cmd==='run_cancel')cancels++;return structuredClone(status)}}}};
 const {subscribeRun}=await import('../frontend/js/run-client.js');
 const initial=[];const off=subscribeRun('job',{onLog:e=>initial.push(e.msg)});
 await new Promise(r=>setTimeout(r,10));off();assert.equal(cancels,0);
 status.logs.push('上传轨迹');const resumed=[];
 const done=new Promise(resolve=>{
  subscribeRun('job',{onLog:e=>resumed.push(e.msg),onDone:resolve});
 });
 await new Promise(r=>setTimeout(r,10));status={...status,status:'done',result:{recordOk:true}};
 await done;assert.deepEqual(initial,['准备','心跳']);assert.deepEqual(resumed,['准备','心跳','上传轨迹']);assert.equal(cancels,0);
});

test('rolling log window continues delivering new messages after retention limit',async()=>{
 let status={status:'running',logs:['a','b'],logStart:0};
 globalThis.window={__TAURI__:{core:{invoke:async()=>structuredClone(status)}}};
 const {subscribeRun}=await import('../frontend/js/run-client.js');const seen=[];
 const done=new Promise(resolve=>subscribeRun('rolling',{onLog:e=>seen.push(e.msg),onDone:resolve}));
 await new Promise(r=>setTimeout(r,10));status={status:'done',logs:['b','c'],logStart:1};await done;
 assert.deepEqual(seen,['a','b','c']);
});
