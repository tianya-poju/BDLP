import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
let fixture;
globalThis.__routeTest={
 h:(tag,attrs={},children=[])=>({tag,...attrs,children,disabled:!!attrs.disabled,append(...items){this.children.push(...items)}}),
 openModal:options=>{fixture.options=options;return {close:()=>options.onClose()}},
 calculatePreview:async()=>({canApply:true,passed:2,total:2,samples:100,outsideCount:0}),Geo:{polyline:()=>({addTo(){}}),marker:()=>({addTo(){return{bindTooltip(){}}}})},toast:()=>{},invoke:(cmd,args)=>fixture.invoke(cmd,args),
 createBaseMap:()=>({remove(){fixture.removed=true}}),drawFence:()=>{},drawPath:()=>{},pointIcon:()=>{}
};
globalThis.L={polyline:()=>({addTo(){}}),marker:()=>({addTo(){return {bindTooltip(){}}}})};
const source=fs.readFileSync(new URL('../frontend/js/auto-route.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const {autoRoute}=await import('data:text/javascript,'+encodeURIComponent('const {h,openModal,toast,invoke,createBaseMap,drawFence,drawPath,pointIcon,Geo,calculatePreview}=globalThis.__routeTest;\n'+source));
const result={points:[[0,0],[0,1],[0,0]],fence:[],outsideSegments:[],order:[{id:'a',point:[0,0]},{id:'b',point:[0,1]}],distanceM:2000,exact:true,covered:2,canApply:true,fenceAvailable:false,minimumM:0};
const tick=()=>new Promise(r=>setImmediate(r));
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
