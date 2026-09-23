import assert from 'node:assert/strict';
import test from 'node:test';
import {waitForRevisionWrites, RevisionWriteBarrier} from '../server/revision-write-barrier';

test('completion barrier includes a revision added during an earlier write',async()=>{
  const resolvers:Array<()=>void>=[];
  const first=new Promise<void>(resolve=>resolvers.push(resolve));
  const writes=[first];
  let complete=false;
  const finalization=waitForRevisionWrites(writes).then(()=>{complete=true;});
  writes.push(new Promise<void>(resolve=>resolvers.push(resolve)));
  resolvers[0]();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(complete,false);
  resolvers[1]();
  await finalization;
  assert.equal(complete,true);
});

test('failed revision persistence blocks completion rather than reporting success', async () => {
  const failed = Promise.reject(new Error('synthetic storage outage'));
  await assert.rejects(waitForRevisionWrites([failed]), /revision/i);
});

test('a failure in a revision appended during the wait also blocks completion', async () => {
  let release!: () => void;
  const writes = [new Promise<void>(resolve => { release = resolve; })];
  const waiting = waitForRevisionWrites(writes);
  const failed = Promise.reject(new Error('synthetic late write failure'));
  void failed.catch(() => {});
  writes.push(failed);
  release();
  await assert.rejects(waiting, /revision/i);
});

test('recovery retries failed durable writes and does not replay acknowledged writes', async () => {
  const barrier = new RevisionWriteBarrier();
  let available = false;
  let failedAttempts = 0;
  let acknowledgedAttempts = 0;
  await barrier.track(async () => { acknowledgedAttempts++; });
  await assert.rejects(barrier.track(async () => {
    failedAttempts++;
    if (!available) throw new Error('synthetic outage');
  }));
  await assert.rejects(barrier.flush(), /Revision persistence failed/);
  assert.equal(failedAttempts, 2);
  available = true;
  await barrier.flush();
  await barrier.flush();
  assert.equal(failedAttempts, 3);
  assert.equal(acknowledgedAttempts, 1);
});

test('concurrent completion waits share a drain and include newly arrived corrections', async () => {
  const barrier = new RevisionWriteBarrier();
  let releaseFirst!: () => void;
  let releaseLast!: () => void;
  barrier.track(() => new Promise(resolve => { releaseFirst = resolve; }));
  await Promise.resolve();
  const completion = barrier.flush();
  assert.equal(barrier.flush(), completion);
  barrier.track(() => new Promise(resolve => { releaseLast = resolve; }));
  await Promise.resolve();
  releaseFirst();
  let done = false;
  void completion.then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(done, false);
  releaseLast();
  await completion;
  assert.equal(done, true);
});
