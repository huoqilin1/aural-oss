import assert from 'node:assert/strict';
import test from 'node:test';
import {makeSignal,verifyAudioContent} from './helpers/audio-content.mjs';
const expected=makeSignal(3),prefix=Array(1600).fill(0);
test('known audio survives bounded media clock alignment',()=>{
  const actual=[...prefix,...expected.slice(0,20000),...expected.slice(20064),...Array(1000).fill(0)];
  const result=verifyAudioContent(expected,actual);assert.ok(result.passed,JSON.stringify(result));
});
test('one missing or repeated microphone transport frame fails content acceptance',()=>{
  for(const actual of [[...prefix,...expected.slice(0,20000),...expected.slice(24096)], [...prefix,...expected.slice(0,24096),...expected.slice(20000)]])assert.equal(verifyAudioContent(expected,actual).passed,false);
});
test('silent or slowed microphone content cannot pass on duration alone',()=>{
  assert.equal(verifyAudioContent(expected,Array(expected.length+1600).fill(0)).passed,false);
  assert.equal(verifyAudioContent(expected,[...prefix,...expected.map((_,i)=>expected[Math.floor(i*2/3)])]).passed,false);
});
