import assert from 'node:assert/strict';
import test from 'node:test';
import {AsrUtteranceReplayGuard} from '../server/asr-utterance-replay';

const segment = {text:'我负责招聘。',definite:true,start_time:0,end_time:1500};
test('full results repeating multiple completed segments do not replay old speech', () => {
  const guard=new AsrUtteranceReplayGuard();
  const first=[segment,{...segment,text:'还负责薪酬核对。',start_time:2000,end_time:3500}];
  assert.equal(first.filter(row=>!guard.isDuplicate(row)).length,2);
  const next=[...first,{...segment,text:'我使用AI整理草稿并人工核实。',start_time:4000,end_time:6000}];
  assert.deepEqual(next.filter(row=>!guard.isDuplicate(row)),[next[2]]);
});
test('the same words spoken at another audio interval are still accepted', () => {
  const guard=new AsrUtteranceReplayGuard();
  assert.equal(guard.isDuplicate(segment),false);
  assert.equal(guard.isDuplicate({...segment,start_time:2000,end_time:3500}),false);
});
test('shorter or longer corrections at the same interval reach the correction handler', () => {
  const guard=new AsrUtteranceReplayGuard();
  for (const text of ['预算是三十万元。','预算三万元。','预算是三万元，包含活动和制作费用。']) {
    assert.equal(guard.isDuplicate({...segment,text}),false);
  }
});
test('a later correction may legitimately return to an earlier wording', () => {
  const guard=new AsrUtteranceReplayGuard();
  for (const text of ['三万元','三十万元','三万元']) {
    assert.equal(guard.isDuplicate({...segment,text}),false);
  }
});
test('interim observations do not consume a later final', () => {
  const guard=new AsrUtteranceReplayGuard();
  assert.equal(guard.isDuplicate({...segment,definite:false}),false);
  assert.equal(guard.isDuplicate({...segment,definite:false}),false);
  assert.equal(guard.isDuplicate(segment),false);
  assert.equal(guard.isDuplicate(segment),true);
});
test('unknown or invalid intervals are never deduplicated by text alone', () => {
  const guard=new AsrUtteranceReplayGuard();
  for (const interval of [{start_time:undefined},{end_time:NaN},{start_time:-1},{start_time:2000,end_time:1000}]) {
    const value={...segment,...interval};
    assert.equal(guard.isDuplicate(value),false);
    assert.equal(guard.isDuplicate(value),false);
  }
});
test('a new ASR socket has a separate interval namespace', () => {
  assert.equal(new AsrUtteranceReplayGuard().isDuplicate(segment),false);
  assert.equal(new AsrUtteranceReplayGuard().isDuplicate(segment),false);
});
