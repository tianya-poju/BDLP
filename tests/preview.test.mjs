import test from 'node:test';
import assert from 'node:assert/strict';
import {previewRoute,simulateSensor} from '../frontend/js/preview-core.js';
const route=[[28.07,112.99],[28.08,112.99],[28.08,113]];
test('preview is reproducible, bounded and accounts for every distance segment',()=>{
  const r=previewRoute(route);
  assert.deepEqual(r,previewRoute(route));
  assert.equal(r.localOnly,true);
  assert.ok(r.speedCurve.length<=120);
  assert.ok(r.trace.length<=401);
  assert.ok(Math.abs(r.speedCurve.at(-1).d-r.distanceKm)<1e-9);
  assert.ok(r.speedCurve.every((p,i,a)=>i===0||p.d>=a[i-1].d));
  assert.ok(r.sensorWave.length>0);
  assert.ok(r.sensorSelfCheck.samples>0);
});
test('speed changes affect preview duration and intermediate route points affect output',()=>{
  const slow=previewRoute(route,{straightSpeed:3,curveSpeed:2.5});
  const fast=previewRoute(route,{straightSpeed:4.5,curveSpeed:4});
  assert.ok(slow.durationS>fast.durationS);
  assert.notDeepEqual(fast,previewRoute([route[0],[28.075,113],route[2]],{straightSpeed:4.5,curveSpeed:4}));
});
test('invalid numbers, excessive route distance and degenerate routes fail explicitly',()=>{
  for(const points of [[],[[0,0]],[[0,0],[NaN,1]],[[0,0],[90,0]],[[0,0],[1,1]],[[28,112],[28,112]]])assert.throws(()=>previewRoute(points));
  for(const config of [{straightSpeed:0},{curveSpeed:Infinity},{gpsIntervalMs:0},{sensorIntensity:NaN},{warmupTime:-1}])assert.throws(()=>previewRoute(route,config));
  assert.throws(()=>simulateSensor({durationS:Infinity}));
});
test('sensor summary is reproducible and responds to intensity',()=>{
  assert.deepEqual(simulateSensor(),simulateSensor());
  assert.ok(simulateSensor({intensity:1.05}).mad.median>simulateSensor({intensity:.85}).mad.median);
});
test('preview worker terminates on completion, supersession and cancellation',async()=>{
  const workers=[];
  globalThis.Worker=class {
    constructor(){workers.push(this)}
    postMessage(data){this.data=data}
    terminate(){this.terminated=true}
  };
  const {calculatePreview,cancelPreviews}=await import('../frontend/js/preview-client.js');
  const first=calculatePreview('route',route).catch(e=>e.message);
  const second=calculatePreview('route',route);
  assert.equal(await first,'预览已取消');assert.equal(workers[0].terminated,true);
  workers[1].onmessage({data:{value:{status:1}}});
  assert.deepEqual(await second,{status:1});assert.equal(workers[1].terminated,true);
  const third=calculatePreview('sensor',{}).catch(e=>e.message);
  cancelPreviews();assert.equal(await third,'预览已取消');assert.equal(workers[2].terminated,true);
  delete globalThis.Worker;
});
