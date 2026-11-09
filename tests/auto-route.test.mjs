import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
let fixture;
globalThis.__routeTest={
 h:(tag,attrs={},children=[])=>({tag,...attrs,children,disabled:!!attrs.disabled,append(...items){this.children.push(...items)}}),
 openModal:options=>{fixture.options=options;return {close:()=>options.onClose()}},
 calculatePreview:async()=>({canApply:true,passed:2,total:2,samples:100,outsideCount:0}),Geo:{polyline:()=>({addTo(){}}),marker:()=>({addTo(){return{bindTooltip(){}}}})},toast:()=>{},invoke:(cmd,args)=>fixture.invoke(cmd,args),
 createBaseMap:()=>{if(fixture.mapError)throw Error('地图初始化失败');return{remove(){fixture.removed=true}}},drawFence:()=>{},drawPath:()=>{},pointIcon:()=>{}
};
globalThis.L={polyline:()=>({addTo(){}}),marker:()=>({addTo(){return {bindTooltip(){}}}})};
const source=fs.readFileSync(new URL('../frontend/js/auto-route.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const {autoRoute}=await import('data:text/javascript,'+encodeURIComponent('const {h,openModal,toast,invoke,createBaseMap,drawFence,drawPath,pointIcon,Geo,calculatePreview}=globalThis.__routeTest;\n'+source));
const result={points:[[0,0],[0,1],[0,0]],fence:[],outsideSegments:[],order:[{id:'a',point:[0,0]},{id:'b',point:[0,1]}],distanceM:2000,exact:true,covered:2,canApply:true,fenceAvailable:false,minimumM:0};
const tick=()=>new Promise(r=>setImmediate(r));

test('polling never overlaps and late status cannot overwrite success or failure',async()=>{
 const realSet=globalThis.setInterval,realClear=globalThis.clearInterval;
 try{
  for(const failure of [false,true]){
   let poll,finish,rejectPlan,finishStatus,statusCalls=0,cleared=0;
   globalThis.setInterval=fn=>{poll=fn;return 99;};
   globalThis.clearInterval=id=>{if(id===99)cleared++;};
   fixture={invoke:(cmd)=>{
    if(cmd==='route_plan')return new Promise((resolve,reject)=>{finish=resolve;rejectPlan=reject;});
    if(cmd==='route_plan_status'){statusCalls++;return new Promise(resolve=>finishStatus=resolve);}
    return Promise.resolve();
   }};
   const modal=autoRoute({});await tick();const pending=poll();await poll();assert.equal(statusCalls,1);
   if(failure)rejectPlan(Error('规划失败'));else finish(result);await tick();
   const final=fixture.options.body[1].textContent;assert.match(final,failure?/规划失败/:/已覆盖/);assert.equal(cleared,1);
   finishStatus({phase:'迟到',completed:0,total:10});await pending;await tick();assert.equal(fixture.options.body[1].textContent,final);
   await poll();assert.equal(statusCalls,1);modal.close();
  }
 }finally{globalThis.setInterval=realSet;globalThis.clearInterval=realClear;}
});
test('closing an outstanding status request discards its result and map creation errors are handled',async()=>{
 const realSet=globalThis.setInterval,realClear=globalThis.clearInterval;
 try{
  let poll,finishPlan,finishStatus,cleared=0;
  globalThis.setInterval=fn=>{poll=fn;return 77;};globalThis.clearInterval=id=>{if(id===77)cleared++;};
  fixture={invoke:cmd=>cmd==='route_plan'?new Promise(r=>finishPlan=r):cmd==='route_plan_status'?new Promise(r=>finishStatus=r):Promise.resolve()};
  const modal=autoRoute({});await tick();const pending=poll();modal.close();const before=fixture.options.body[1].textContent;
  finishStatus({phase:'late'});finishPlan(result);await pending;await tick();assert.equal(fixture.options.body[1].textContent,before);assert.equal(cleared,1);
  fixture={mapError:true,invoke:cmd=>{if(cmd==='route_plan_cancel')return Promise.resolve();throw Error('Unexpected request')}};
  const failed=autoRoute({});await tick();assert.match(fixture.options.body[1].textContent,/地图初始化失败/);failed.close();
 }finally{globalThis.setInterval=realSet;globalThis.clearInterval=realClear;}
});
test('closing preview cancels native candidate and discards late response',async()=>{
 let finish;const calls=[];fixture={invoke:(cmd,args)=>{calls.push(cmd);if(cmd==='route_plan')return new Promise(r=>finish=r);return Promise.resolve()}};
 const modal=autoRoute({});await tick();modal.close();finish(result);await tick();
 assert.ok(fixture.removed);assert.deepEqual(calls,['route_plan','route_plan_cancel']);assert.equal(fixture.options.footer[1].disabled,true);
});
test('candidate is preview only until apply succeeds; stale failure does not refresh',async()=>{
 let refreshed=0;const calls=[];fixture={invoke:async cmd=>{calls.push(cmd);if(cmd==='route_plan')return result;if(cmd==='route_plan_apply')throw Error('账号或跑区已改变')}};
 autoRoute({refresh:async()=>refreshed++});await tick();assert.deepEqual(calls,['route_plan']);const button=fixture.options.footer[1];assert.equal(button.disabled,false);await button.onClick();assert.equal(refreshed,0);assert.match(fixture.options.body[1].textContent,/已改变/);
});
test('outside fence disables apply and valid apply refreshes once',async()=>{
 fixture={invoke:async cmd=>cmd==='route_plan'?{...result,canApply:false,outsideSegments:[0]}:undefined};autoRoute({});await tick();assert.equal(fixture.options.footer[1].disabled,true);
 let refreshed=0;fixture={invoke:async cmd=>cmd==='route_plan'?result:undefined};autoRoute({refresh:async()=>refreshed++});await tick();await fixture.options.footer[1].onClick();assert.equal(refreshed,1);
});

test('partial coverage displays all checkpoint count and cannot apply',async()=>{
 const partial={...result,covered:1,canApply:false,coverage:[{id:'a',distanceM:0,radiusM:30,covered:true},{id:'b',distanceM:60,radiusM:30,covered:false}]};
 fixture={invoke:async cmd=>cmd==='route_plan'?partial:undefined};autoRoute({});await tick();assert.match(fixture.options.body[1].textContent,/已覆盖 1\/2/);assert.equal(fixture.options.footer[1].disabled,true);
});

test('large checkpoint detail is collapsed, with only failed points in the main summary',async()=>{
 const coverage=Array.from({length:160},(_,i)=>({id:String(i),distanceM:i===11?59.4:3.2,radiusM:30,radiusSource:'local_default',covered:i!==11}));
 fixture={invoke:async cmd=>cmd==='route_plan'?{...result,coverage,covered:159,canApply:false}:undefined};autoRoute({});await tick();
 const body=fixture.options.body;assert.equal(body[2].class,'map route-preview-map');assert.equal(body[4].tag,'details');assert.equal(body[4].open,undefined);assert.equal(body[4].children[0].text,'查看详情');assert.equal(body[3].children.filter(n=>n.text?.startsWith('未覆盖点')).length,1);
 const detail=body[4].children[1];assert.equal(detail.children.filter(n=>n.text?.includes('本地30米')).length,1);assert.ok(detail.children.some(n=>n.text?.includes('直线'))||detail.children.some(n=>n.textContent?.includes('直线')));
});

test('editor callbacks receive points only after successful apply, never on cancel',async()=>{
 let edits=0,closed=0;fixture={invoke:async cmd=>cmd==='route_plan'?result:undefined};
 let modal=autoRoute({refresh:async()=>{}},{onApplied:()=>edits++,onClose:()=>closed++});await tick();modal.close();assert.equal(edits,0);
 modal=autoRoute({refresh:async()=>{}},{onApplied:p=>{assert.equal(p,result.points);edits++;},onClose:()=>closed++});await tick();await fixture.options.footer[1].onClick();assert.equal(edits,1);assert.equal(closed,2);
});
