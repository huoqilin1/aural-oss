import assert from 'node:assert/strict';
import test from 'node:test';
import {sessionRouter} from '../src/server/routers/session';

function client(results: unknown[]) {
  const writes: unknown[] = [];
  const supabase = {from() {
    let accessLookup=false;
    const query: any = {then(resolve: any, reject: any) {
      const result=accessLookup ? {data:{id:'synthetic',interview:{id:'public',title:'Public practice'}},error:null} : results.shift();
      assert.ok(result,'unexpected database operation');
      return Promise.resolve(result).then(resolve,reject);
    }};
    for (const key of ['select','eq','order','limit','single','maybeSingle','delete']) query[key] = () => query;
    query.select=(columns:string)=>{accessLookup=columns==='id, interview:interviews!inner(id,title,userId,projectId,project:projects(organizationId))';return query;};
    query.update = (value: unknown) => { writes.push(value); return query; };
    query.insert = (value: unknown) => { writes.push(value); return query; };
    return query;
  }};
  return {caller: sessionRouter.createCaller({supabase,user:null} as any), writes};
}
const ok = (data: unknown) => ({data,error:null});
const failure = {data:null,error:{code:'PVR02'}};

test('progress rejects a different interview question before writing', async () => {
  const subject=client([ok({id:'synthetic',interviewId:'job-a',status:'IN_PROGRESS'}),ok(null)]);
  await assert.rejects(subject.caller.updateCurrentQuestion({sessionId:'synthetic',questionId:'foreign'}),/does not belong/);
  assert.equal(subject.writes.length,0);
});

test('progress refuses completed sessions and failed database reads', async () => {
  for (const result of [failure,ok(null),ok({id:'synthetic',status:'COMPLETED'})]) {
    const subject=client([result]);
    await assert.rejects(subject.caller.updateCurrentQuestion({sessionId:'synthetic',questionId:'q1'}));
    assert.equal(subject.writes.length,0);
  }
});

test('progress requires a successful write to a still active session', async () => {
  for (const final of [failure,ok(null),ok({id:'synthetic'})]) {
    const subject=client([ok({id:'synthetic',interviewId:'job-a',status:'IN_PROGRESS'}),ok({id:'q1'}),final]);
    const result=subject.caller.updateCurrentQuestion({sessionId:'synthetic',questionId:'q1'});
    if (final.data) assert.deepEqual(await result,{success:true});
    else await assert.rejects(result);
  }
});

test('recording metadata requires an actual session write acknowledgment', async () => {
  const input = {sessionId:'synthetic',audioRecordingUrl:'/synthetic-recording.webm'};
  await assert.rejects(client([ok(null)]).caller.saveRecording(input),/no longer exists/);
  await assert.rejects(client([failure]).caller.saveRecording(input));
  assert.deepEqual(await client([ok({id:'synthetic'})]).caller.saveRecording(input),
    {success:true,sessionId:'synthetic'});
});

test('an empty recording save cannot claim success without writing', async () => {
  await assert.rejects(client([]).caller.saveRecording({sessionId:'synthetic'}),/No recording metadata/);
});

test('alternate completion reports a rejected database write as failure', async () => {
  const {caller,writes} = client([
    ok({id:'synthetic',startedAt:'2026-09-05T00:00:00Z',status:'IN_PROGRESS',voiceRevision:8}),
    ok({timestamp:'2026-09-05T00:00:00Z'}), failure,
  ]);
  await assert.rejects(caller.complete({id:'synthetic'}),/complete interview session failed/);
  assert.equal((writes[0] as any).completedVoiceRevision,8);
});

test('alternate completion passes the loaded version on success', async () => {
  const {caller,writes} = client([
    ok({id:'synthetic',startedAt:'2026-09-05T00:00:00Z',status:'IN_PROGRESS',voiceRevision:12}),
    ok({timestamp:'2026-09-05T00:00:00Z'}), ok({id:'synthetic'}),
  ]);
  assert.deepEqual(await caller.complete({id:'synthetic'}),{success:true});
  assert.equal((writes[0] as any).completedVoiceRevision,12);
});

test('a session deleted between load and update cannot return completed', async () => {
  const {caller} = client([
    ok({id:'synthetic',startedAt:'2026-09-05T00:00:00Z',status:'IN_PROGRESS',voiceRevision:12}),
    ok({timestamp:'2026-09-05T00:00:00Z'}), ok(null),
  ]);
  await assert.rejects(caller.complete({id:'synthetic'}),/no longer exists/);
});

test('a completed session is not stamped with a new completion time on retry', async () => {
  const {caller,writes} = client([ok({id:'synthetic',status:'COMPLETED'})]);
  assert.deepEqual(await caller.complete({id:'synthetic'}),{success:true});
  assert.equal(writes.length,0);
});

for (const existing of [null,{id:'message'}]) {
  test(`whiteboard evidence ${existing ? 'update' : 'insert'} failures reach the caller`, async () => {
    const {caller} = client([ok({id:'synthetic'}),ok(existing),failure]);
    await assert.rejects(caller.saveWhiteboard({sessionId:'synthetic',drawingId:'drawing',snapshotData:'{}'}),/whiteboard evidence failed/);
  });
  test(`code evidence ${existing ? 'update' : 'insert'} failures reach the caller`, async () => {
    const {caller} = client([ok({id:'synthetic'}),ok(existing),failure]);
    await assert.rejects(caller.saveCode({sessionId:'synthetic',snippetId:'code',snapshotData:'{}'}),/code evidence failed/);
  });
}
test('evidence deletion failures do not return success', async () => {
  await assert.rejects(client([failure]).caller.deleteWhiteboard({sessionId:'synthetic',drawingId:'drawing'}),/delete whiteboard evidence failed/);
  await assert.rejects(client([failure]).caller.deleteCode({sessionId:'synthetic',snippetId:'code'}),/delete code evidence failed/);
});
