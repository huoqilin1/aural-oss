import assert from 'node:assert/strict';
import test from 'node:test';
import {waitForProgressSaves, SingleFlightSave} from '../src/lib/voice/progress-save';

test('completion includes a new progress save queued during the first wait', async () => {
  let releaseFirst!: () => void;
  let releaseLast!: () => void;
  let tail = new Promise<void>(resolve => { releaseFirst = resolve; });
  let completed = false;
  const waiting = waitForProgressSaves(() => tail).then(() => { completed = true; });
  tail = tail.then(() => new Promise<void>(resolve => { releaseLast = resolve; }));
  releaseFirst();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(completed, false);
  releaseLast();
  await waiting;
  assert.equal(completed, true);
});

test('an uncaught progress failure does not authorize completion', async () => {
  const tail = Promise.reject(new Error('synthetic save failure'));
  await assert.rejects(waitForProgressSaves(() => tail), /synthetic save failure/);
});

test('a timed-out caller retry joins the running completion without duplicate writes', async () => {
  const flight = new SingleFlightSave<boolean>();
  let release!: () => void;
  let writes = 0;
  let cleanups = 0;
  const save = async () => {
    writes++;
    await new Promise<void>(resolve => { release = resolve; });
    cleanups++;
    return true;
  };
  const first = flight.run(save);
  await Promise.resolve();
  const timeout = Symbol('UI timeout');
  assert.equal(await Promise.race([first, Promise.resolve(timeout)]), timeout);
  const retry = flight.run(save);
  assert.equal(first, retry);
  assert.equal(writes, 1);
  release();
  assert.deepEqual(await Promise.all([first, retry]), [true, true]);
  assert.equal(cleanups, 1);
});

test('a failed completion can be retried after settling', async () => {
  const flight = new SingleFlightSave<boolean>();
  await assert.rejects(flight.run(async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await flight.run(async () => true), true);
});

test('a synchronous save exception releases the flight for retry', async () => {
  const flight = new SingleFlightSave<boolean>();
  await assert.rejects(flight.run(() => { throw new Error('setup failed'); }), /setup failed/);
  assert.equal(await flight.run(async () => true), true);
});
