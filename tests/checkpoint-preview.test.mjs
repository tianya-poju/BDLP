import test from 'node:test';import assert from 'node:assert/strict';
import {verifyCheckpointPreview,segmentInside} from '../frontend/js/checkpoint-preview.js';
test('checkpoint preview checks all IDs including co-located points with deterministic sampling',()=>{
 const points=[[28,112],[28,112.001],[28.001,112.001],[28,112]],order=points.slice(0,-1).map((point,i)=>({id:String(i),point}));order.push({id:'same',point:points[0]});
 const coverage=order.map(c=>({id:c.id,radiusM:30}));const a=verifyCheckpointPreview(points,order,coverage),b=verifyCheckpointPreview(points,order,coverage);assert.deepEqual(a,b);assert.equal(a.passed,4);assert.ok(a.canApply);assert.ok(a.distanceM>0);
});
test('uncovered point and outside samples cannot pass',()=>{
 const p=[[28,112],[28,112.001],[28,112]],order=[{id:'far',point:[28.01,112]}];const a=verifyCheckpointPreview(p,order,[]);assert.ok(!a.canApply);assert.deepEqual(a.missingIds,['far']);
 const b=verifyCheckpointPreview(p,[],[],[[29,113],[29,114],[30,114],[30,113]]);assert.ok(!b.canApply);assert.ok(b.outsideCount>0);
});
test('concave fence checks whole segments rather than only endpoints',()=>{
 const f=[[0,0],[0,3],[3,3],[3,2],[1,2],[1,1],[3,1],[3,0]];
 assert.equal(segmentInside([2,.5],[2,2.5],f),false);assert.equal(segmentInside([.5,.5],[.5,2.5],f),true);
});
