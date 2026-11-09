import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleRoute,previewRoute} from '../frontend/js/preview-core.js';
import {prepareRun} from '../frontend/js/run-plan.js';
import {verifyCheckpointPreview} from '../frontend/js/checkpoint-preview.js';
const points=[[28,112],[28.002,112],[28.002,112.002],[28,112]];
test('task preparation, displayed preview and coverage use the exact same deterministic sample',()=>{
 const config={straightSpeed:4,curveSpeed:3,gpsIntervalMs:10000},rules={android_gps_max_distance:8};
 const sampled=sampleRoute(points,config,rules);
 const start={mode:'free',points,runConfig:config};
 const prepared={rules,timestamp:{timestamp:Date.UTC(2026,10,4,4)/1000}};
 const plan=prepareRun(start,prepared),again=prepareRun(start,prepared);
 assert.deepEqual(plan.points,sampled.pts);assert.deepEqual(again,plan);assert.equal(sampled.interval,2);
 const preview=previewRoute(points,config,rules);assert.equal(preview.pointCount,plan.points.length);assert.equal(preview.durationS,plan.points.at(-1).t);assert.equal(preview.estimated,false);
 const coverage=verifyCheckpointPreview(points,[],[],[],config,rules);assert.equal(coverage.samples,plan.points.length);
 assert.equal(previewRoute(points,config).estimated,true);assert.notDeepEqual(sampled.pts,sampleRoute(points,config,{android_gps_max_distance:4}).pts);
});
test('all sample entrypoints share backend bounds including slower curve speed',()=>{
 assert.doesNotThrow(()=>sampleRoute(points,{curveSpeed:.5}));
 for(const config of [{straightSpeed:5.1},{curveSpeed:.49},{maxAccel:3.1},{warmupTime:61},{cooldownTime:61},{gpsIntervalMs:10001}]){
  assert.throws(()=>sampleRoute(points,config));assert.throws(()=>previewRoute(points,config));assert.throws(()=>verifyCheckpointPreview(points,[],[],[],config));assert.throws(()=>prepareRun({mode:'free',points,runConfig:config},{rules:{},timestamp:{timestamp:1}}));
 }
});
