import assert from 'node:assert/strict';
import test from 'node:test';
import {saveInterviewEvidence, saveRecordingMetadata} from '../src/lib/voice/evidence-save';

for (const result of [{result:{data:{json:{message:{id:'synthetic'}}}}},{result:{data:{message:{id:'synthetic'}}}}]) {
  test('evidence save requires an acknowledged stored record: '+JSON.stringify(result),async () => {
    await saveInterviewEvidence('/synthetic',{},async () => Response.json(result));
  });
}
for (const result of [{error:{message:'failed'}},{result:{data:{json:{message:null}}}},{ok:true}]) {
  test('HTTP 200 without a stored evidence record is rejected: '+JSON.stringify(result),async () => {
    await assert.rejects(saveInterviewEvidence('/synthetic',{},async () => Response.json(result)),/尚未确认保存/);
  });
}
test('HTTP failure and disconnected transport cannot be acknowledged', async () => {
  await assert.rejects(saveInterviewEvidence('/synthetic',{},async () => new Response('',{status:503})),/503/);
  await assert.rejects(saveInterviewEvidence('/synthetic',{},async () => {throw Error('offline');}),/offline/);
});

test('recording metadata acknowledgment must name this session', async () => {
  const payload = {sessionId:'synthetic',audioRecordingUrl:'/synthetic.webm'};
  for (const data of [{success:true},{success:true,sessionId:'another'},{success:false,sessionId:'synthetic'}]) {
    await assert.rejects(saveRecordingMetadata(payload,async () => Response.json({result:{data:{json:data}}})),/尚未确认/);
  }
  for (const data of [{json:{success:true,sessionId:'synthetic'}},{success:true,sessionId:'synthetic'}]) {
    await saveRecordingMetadata(payload,async () => Response.json({result:{data}}));
  }
  await assert.rejects(saveRecordingMetadata(payload,async () => new Response('',{status:503})),/503/);
});
