// Deterministic comparison of the baseline and corrected content checker.
// Synthetic signals only. This does not explain a historical capture without PCM.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {makeSignal,verifyAudioContent} from '../tests/helpers/audio-content.mjs';
const root=resolve(import.meta.dirname,'..');
const baseline='b478728f379c75c0f85f89d95d18dbee0c15c71e';
const oldSource=execFileSync('git',['show',`${baseline}:tests/helpers/audio-content.mjs`],{cwd:root,encoding:'utf8'});
const {verifyAudioContent:oldVerify}=await import('data:text/javascript;base64,'+Buffer.from(oldSource).toString('base64'));
const expected=makeSignal(5),cases=[];
for(const at of [20000,48000,48480,48800]){
  for(const count of [160,4096]){
    const actual=[...Array(1600).fill(0),...expected.slice(0,at),...expected.slice(at+count),...Array(1000).fill(0)];
    const old=oldVerify(expected,actual),current=verifyAudioContent(expected,actual);
    assert.equal(current.passed,count===160);
    if(count===4096)assert.equal(old.passed,false);
    cases.push({at,count,old,current});
  }
}
assert.equal(cases[0].old.passed,true);
assert.ok(cases.some(row=>row.count===160&&!row.old.passed));
const report={baseline,scope:'test-checker position invariance only',historicalFailureRootCauseProven:false,cases};
writeFileSync(resolve(root,'output/audio-anchor-counterexample.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:true,cases:cases.length,baselinePositionSensitive:true,transportLossStillRejected:true,historicalFailureRootCauseProven:false}));
