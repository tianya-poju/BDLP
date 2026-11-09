import test from 'node:test';
import assert from 'node:assert/strict';
let failRequirements=false;
globalThis.window={__TAURI__:{core:{invoke:async(cmd,{kind})=>{
  assert.equal(cmd,'network_read');
  if(kind==='records')return {data:{list:[],total_num:0}};
  if(kind==='scores')return {data:{term_list:[{term_info:{term_id:'old'}},{score_info:{term_id:'now',is_this_term:1,total_score_num:34}}]}};
  if(kind==='term_score')return {data:{total_score_num:'35'}};
  if(kind==='term_requirements'){
    if(failRequirements)throw Error('学校规则请求超时');
    return {data:{term_id:'now',term_num:'48'}};
  }
  throw Error('Unexpected '+kind);
}}}};
const {api}=await import('../frontend/js/api.js');
test('record API joins current term detail with same-term school requirements',async()=>{
  const r=await api.records('2026');
  assert.equal(r.score.completedCount,35);
  assert.equal(r.score.requiredCount,48);
  assert.equal(r.score.remainingCount,13);
});
test('requirement network failure retains completed count and explains missing data',async()=>{
  failRequirements=true;
  const r=await api.records('2026');
  assert.equal(r.score.completedCount,35);
  assert.equal(r.score.remainingCount,null);
  assert.match(r.scoreError,/学校规则请求超时/);
});
