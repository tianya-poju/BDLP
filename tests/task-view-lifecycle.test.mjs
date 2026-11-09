import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
let fixture;
globalThis.__taskView={
 h:(tag,attrs={},children=[])=>({tag,...attrs,children}),svg:()=>({}),toast:()=>fixture.toasts++,
 fmtKm:String,pref:{get:()=> 'free',set(){}},api:{runStart:()=>fixture.start()},subscribeJob:(id,callbacks)=>{fixture.subscriptions.push({id,callbacks});return()=>fixture.unsubscribes++;},
 subscribeJobs:callback=>{fixture.registry=callback;return()=>fixture.registryStopped=true;},
};
const source=fs.readFileSync(new URL('../frontend/js/views/console/tasks.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const {createTasks}=await import('data:text/javascript,'+encodeURIComponent('const {h,svg,toast,fmtKm,pref,api,subscribeJob,subscribeJobs}=globalThis.__taskView;\n'+source));
function setup(){
 fixture={toasts:0,subscriptions:[],unsubscribes:0,start:()=>new Promise(r=>fixture.finish=r)};
 const uploadCard={children:[],append(...n){this.children.push(...n)}},app={state:{activeUid:'a',runConfig:{straightSpeed:4,curveSpeed:3},route:{points:[[28,112],[28.001,112]],distanceKm:1}},refresh:async()=>{fixture.refreshes=(fixture.refreshes||0)+1;}};
 const view=createTasks({app,uploadCard,logPanel:{count:0,clear(){},append(){}},goAlipay:()=>fixture.faces=(fixture.faces||0)+1});view.renderUpload();
 const button=uploadCard.children[1].children.find(n=>n?.title==='主动启动后将向乐跑服务提交记录');return{view,app,button};
}
test('destroy during task preparation never resubscribes or updates current UI after completion',async()=>{
 const {view,app,button}=setup();const pending=button.onClick();view.destroy();fixture.finish({jobId:'backend-owned'});await pending;
 assert.equal(fixture.subscriptions.length,0);assert.equal(fixture.toasts,0);assert.equal(app.state.running,undefined);
});
test('account changes discard delayed task preparation and repeated start clicks are coalesced',async()=>{
 const {app,button}=setup();let count=0;fixture.start=()=>{count++;return new Promise(r=>fixture.finish=r);};const pending=button.onClick();await button.onClick();assert.equal(count,1);app.state.activeUid='b';fixture.finish({jobId:'old-account'});await pending;assert.equal(fixture.subscriptions.length,0);assert.equal(app.state.running,undefined);
});
test('destroyed subscriptions ignore late logs, face requests and completion',async()=>{
 const {view,app}=setup();app.state.running={current:{id:'job'}};view.destroy();const second=createTasks({app,uploadCard:{append(){}},logPanel:{count:0,append(){throw Error('late log');}},goAlipay(){throw Error('late face')}});second.startWatching();const {callbacks}=fixture.subscriptions[0];second.destroy();callbacks.onLog({msg:'late'});callbacks.onFaceRequest({});await callbacks.onDone({status:'done'});assert.equal(fixture.refreshes,undefined);assert.equal(fixture.toasts,0);
});
test('remounted console restores a task created during preparation and detaches its registry listener',()=>{
 const {view,app}=setup();view.startWatching();fixture.registry({uid:'a',current:{id:'rust-job'},latest:{id:'rust-job'}});assert.equal(fixture.subscriptions[0].id,'rust-job');assert.equal(app.state.running.current.id,'rust-job');
 view.destroy();assert.equal(fixture.registryStopped,true);fixture.registry({uid:'a',current:{id:'late'}});assert.equal(fixture.subscriptions.length,1);
});
