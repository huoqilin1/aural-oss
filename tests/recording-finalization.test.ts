import assert from "node:assert/strict";
import test from "node:test";
import { retryableSingleFlight } from "../src/lib/voice/retryable-single-flight";

test("recording finalization waits past eight seconds, shares work and retains its URL", async (t) => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let uploads = 0;
  const stop = retryableSingleFlight(async () => {
    uploads++;
    await new Promise((resolve)=>setTimeout(resolve, 9000));
    return {audioUrl:"https://example.test/local-only-recording"};
  });
  let complete = false;
  const first = stop().then((result)=>{complete=true;return result;});
  const second = stop();
  await Promise.resolve();
  t.mock.timers.tick(8001);
  await Promise.resolve();
  assert.equal(complete, false);
  t.mock.timers.tick(1000);
  assert.deepEqual(await first, await second);
  assert.deepEqual(await stop(), await first);
  assert.equal(uploads, 1);
});

test("failed recording save is not a successful completion and can be retried", async () => {
  let attempts = 0;
  const stop = retryableSingleFlight(async () => {
    if (++attempts === 1) throw new Error("link failed");
    return {audioUrl:"https://example.test/local-only-recording"};
  });
  await assert.rejects(stop(), /link failed/);
  assert.ok((await stop()).audioUrl);
  assert.ok((await stop()).audioUrl);
  assert.equal(attempts, 2);
});
