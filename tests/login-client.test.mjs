import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoginClient} from '../frontend/js/login-client.js';
const tick=()=>new Promise(r=>setImmediate(r));
test('closing during authorization start cancels its ID and ignores late notification',async()=>{
 let finish;const calls=[];const owner=Symbol();const client=createLoginClient(async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='qq_login_start')return new Promise(r=>finish=r);},()=> 'first');
 const start=client.start('qq',owner).catch(e=>e.message);await tick();await client.cancel(owner);finish();assert.equal(await start,'登录已取消');assert.equal(client.finish({attemptId:'first',ok:true}),false);assert.ok(calls.some(([cmd,a])=>cmd==='login_cancel'&&a.id==='first'));
});
test('cross-platform attempts discard older result; destroying older view cannot cancel newer login',async()=>{
 let resolveOld,count=0;const calls=[];const a=Symbol(),b=Symbol();const client=createLoginClient(async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='qq_login_start')return new Promise(r=>resolveOld=r);if(cmd==='wechat_login_start')return{sid:args.attemptId};},()=>String(++count));
 const old=client.start('qq',a).catch(e=>e.message);await tick();const next=await client.start('wechat',b);await client.cancel(a);resolveOld();assert.equal(await old,'登录已取消');assert.equal(client.finish({attemptId:'1',ok:true}),false);assert.equal(client.finish({attemptId:next.attemptId,ok:true}),true);assert.equal(client.finish({attemptId:next.attemptId,ok:true}),false);assert.ok(!calls.some(([cmd,args])=>cmd==='login_cancel'&&args.id==='2'));
});
test('begin acknowledgments are serialized and late cancellation targets only its own attempt',async()=>{
 let beginOld,count=0;const calls=[];const client=createLoginClient(async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='login_begin'&&args.id==='1')return new Promise(r=>beginOld=r);return{};},()=>String(++count));
 const a=client.start('wechat','a').catch(e=>e.message);await tick();const b=client.start('qq','b');await tick();assert.equal(calls.filter(([cmd])=>cmd==='login_begin').length,1);beginOld();await b;assert.equal(await a,'登录已取消');assert.equal(client.finish({attemptId:'2'}),true);
});
test('failed begin or launch cleans current authorization and emits no acceptable success',async()=>{
 for(const failed of ['login_begin','qq_login_start']){
  const client=createLoginClient(async cmd=>{if(cmd===failed)throw Error('blocked');},()=> 'x');await assert.rejects(client.start('qq','owner'),/blocked/);assert.equal(client.finish({attemptId:'x',ok:true}),false);
 }
});
