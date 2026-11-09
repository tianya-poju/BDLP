import test from 'node:test';import assert from 'node:assert/strict';
import {diagnose} from '../frontend/js/diagnosis.js';
test('rules parser tolerates absent data and preserves school gates',()=>{const d=diagnose({});assert.ok(Array.isArray(d.configLines));assert.ok(d.summary);const g=diagnose({is_check_geetest:1,run_face_verify_config:{is_open:1},run_zone_latlng:[]});assert.ok(g.configLines.some(s=>s.includes('极验')));});
globalThis.window={__TAURI__:{core:{invoke:async(cmd,args)=>{if(cmd==='local_state')return {account:{uid:'test',realName:'测试用户',hasToken:true},school_id:'297',school_name:'测试学校',route:[],zone:{id:'zone',fence:[]},run_config:{}};if(cmd==='config_save')return {status:1};if(cmd==='network_read'){if(args.kind==='rank')return {status:1,data:{rank_list:[{uid:'test',name:'测试',rank:2,distance:'12.5',score_num:'5'}],my_rank:[{uid:'test',rank:2}]}};if(args.kind==='records')return {status:1,data:{list:[],total_num:0}};if(args.kind==='scores')throw Error('成绩服务暂不可用');}throw Error('unexpected command')}}}};
const {api}=await import('../frontend/js/api.js');
test('state exposes name without requiring token in frontend',async()=>{const state=await api.state();assert.equal(state.account.label,'测试用户');assert.equal(state.account.token,undefined);});
test('records retain score error and empty pagination',async()=>{const records=await api.records('2026');assert.equal(records.status,1);assert.equal(records.hasMore,false);assert.match(records.scoreError,/成绩服务暂不可用/);});
import {PACE_OPTIONS,calculate} from '../frontend/js/pace.js';
test('original speed levels are available and generate usable parameters',()=>{assert.equal(PACE_OPTIONS.length,4);for(let i=0;i<4;i++){const c=calculate(i);assert.ok(c.straightSpeed>=2.5&&c.straightSpeed<=5);assert.ok(c.curveSpeed>=2&&c.curveSpeed<=4.5);assert.ok(c.cadenceSpm>=145&&c.cadenceSpm<=180);}});

test('pace selection returns the fields consumed by the console',async()=>{
  const reply=await api.paceFor(2);
  assert.equal(reply.paceResult,reply.runConfig);
  assert.equal(reply.runConfig.paceLevel,2);
  assert.ok(reply.paceResult.straightSpeed>0);
});

test('rank normalizes numeric server fields and personal ranking',async()=>{const r=await api.rank(3,null,1,1);assert.equal(r.list[0].distance,12.5);assert.equal(r.list[0].scoreNum,5);assert.equal(r.myRank.uid,'test');assert.equal(r.hasMore,true)});
