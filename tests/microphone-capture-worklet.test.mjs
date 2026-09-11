import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

function microphone() {
  const pending = [];
  let Processor;
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage(value, transfer) {
        pending.push(structuredClone(value, { transfer }));
      } };
    }
  }
  vm.runInNewContext(fs.readFileSync("public/audio/microphone-capture.worklet.js", "utf8"), {
    AudioWorkletProcessor, registerProcessor(name, value) {
      assert.equal(name, "oprun-microphone-capture"); Processor = value;
    },
  });
  return { processor: new Processor(), pending };
}

test("capture retains ordered samples while the UI does not consume messages", () => {
  const {processor, pending} = microphone();
  const expected = Float32Array.from({length: 4096 * 12}, (_, i) => Math.sin(i * 0.013));
  for (let offset = 0; offset < expected.length; offset += 128) {
    assert.equal(processor.process([[expected.subarray(offset, offset + 128)]]), true);
  }
  // Read only after all audio was captured, like a stalled UI thread resuming.
  assert.equal(pending.length, 12);
  assert.deepEqual(pending.flatMap(block => Array.from(block)), Array.from(expected));
  assert.equal(new Set(pending.map(block => block.buffer)).size, 12);
});

test("capture handles input boundaries and stops accepting audio after shutdown", () => {
  const {processor, pending} = microphone();
  assert.equal(processor.process([]), true);
  const expected = Float32Array.from({length: 8192}, (_, i) => i / 8192);
  for (const [start,end] of [[0,31],[31,4090],[4090,8000],[8000,8192]]) {
    processor.process([[expected.subarray(start,end)]]);
  }
  assert.deepEqual(pending.flatMap(block => Array.from(block)), Array.from(expected));
  processor.port.onmessage({data:{type:"stop"}});
  assert.equal(processor.process([[expected]]), false);
  assert.equal(pending.length, 2);
});
