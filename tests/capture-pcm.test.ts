import assert from "node:assert/strict";
import test from "node:test";
import { MicrophonePcmFramer } from "../src/lib/voice/capture-pcm";
const flatten=(frames:Float32Array[])=>Float32Array.from(frames.flatMap(frame=>Array.from(frame)));
test("native rates retain exact complete 16 kHz frames across callback boundaries",()=>{
  for(const rate of [8000,16000,24000,44100,48000]){
    const input=Float32Array.from({length:rate*4},(_,i)=>Math.sin(2*Math.PI*400*i/rate)*0.2);
    const all=flatten(new MicrophonePcmFramer(rate).push(input));
    const framer=new MicrophonePcmFramer(rate);const frames:Float32Array[]=[];
    for(let i=0;i<input.length;i+=997)frames.push(...framer.push(input.subarray(i,i+997)));
    assert.equal(all.length,Math.floor(4*16000/4096)*4096);
    assert.ok(frames.every(frame=>frame.length===4096));assert.deepEqual(flatten(frames),all);
  }
});
test("48 kHz conversion averages each complete interval without pitch or frame drift",()=>{
  const input=Float32Array.from({length:48000*60},(_,i)=>Math.sin(2*Math.PI*1000*i/48000)*0.3);
  const result=flatten(new MicrophonePcmFramer(48000).push(input));
  assert.equal(result.length,Math.floor(60*16000/4096)*4096);
  for(let i=0;i<result.length;i++)assert.ok(Math.abs(result[i]-(input[i*3]+input[i*3+1]+input[i*3+2])/3)<1e-7);
});
test("partial microphone frames carry over, while a new capture cannot replay old samples",()=>{
  const framer=new MicrophonePcmFramer(16000);assert.equal(framer.push(new Float32Array(4095).fill(0.25)).length,0);
  const [frame]=framer.push(new Float32Array([0.5]));assert.equal(frame.length,4096);assert.equal(frame[4095],0.5);
  const [fresh]=new MicrophonePcmFramer(16000).push(new Float32Array(4096));assert.ok(fresh.every(value=>value===0));
});
