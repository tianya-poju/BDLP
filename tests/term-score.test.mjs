import test from 'node:test';
import assert from 'node:assert/strict';
import {pickTerm, normalizeTermScore} from '../frontend/js/term-score.js';
test('term requirement uses beforeRun term_num only for matching term',()=>{
  const term={term_info:{term_id:'current'},score_info:{total_score_num:35}};
  const score=normalizeTermScore(term,{total_score_num:'36'},{term_id:'current',term_num:'48'});
  assert.equal(score.requiredCount,48); assert.equal(score.completedCount,36); assert.equal(score.remainingCount,12);
  assert.equal(normalizeTermScore(term,null,{term_id:'previous',term_num:48}).requiredCount,null);
});
test('zero is a real count; absent malformed fields never become zero',()=>{
  const term={term_info:{term_id:'a'}};
  assert.equal(normalizeTermScore(term,{total_score_num:0},{term_id:'a',term_num:48}).remainingCount,48);
  for(const bad of [null,undefined,'',false,'unknown',-1,2.5]){
    assert.equal(normalizeTermScore(term,{}, {term_id:'a',term_num:bad}).requiredCount,null);
  }
  assert.equal(normalizeTermScore(term,{}, {term_id:'a',term_num:48}).remainingCount,null);
  assert.equal(normalizeTermScore(term,{total_score_num:50},{term_id:'a',term_num:48}).remainingCount,0);
});
test('current term marker and id may be in score_info',()=>{
  const current={score_info:{is_this_term:1,term_id:'b',total_score_num:8}};
  const picked=pickTerm([{term_info:{term_id:'a'}},current]);assert.equal(picked,current);
  assert.equal(normalizeTermScore(picked,null,{term_id:'b',term_num:48}).remainingCount,40);
});
