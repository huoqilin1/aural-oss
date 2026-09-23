import assert from 'node:assert/strict';
import test from 'node:test';
import {MediaUploadQueue,uploadInterviewMedia} from '../src/lib/voice/media-upload-queue';

test('failed media remains retryable while successful uploads are not repeated',async()=>{
  const queue=new MediaUploadQueue();let successCalls=0,failedCalls=0,fail=true;
  queue.add(async()=>{successCalls++;});
  queue.add(async()=>{failedCalls++;if(fail)throw Error('offline');});
  await assert.rejects(queue.flush(),/尚未上传/);
  fail=false;await queue.flush();await queue.flush();
  assert.equal(successCalls,1);assert.equal(failedCalls,2);
});
test('end waits for the last screenshot and joins simultaneous retries',async()=>{
  const queue=new MediaUploadQueue();let release!:()=>void;let secondRelease!:()=>void;
  queue.add(()=>new Promise<void>(r=>{release=r;}));
  const first=queue.flush();assert.equal(queue.flush(),first);
  await Promise.resolve();
  queue.add(()=>new Promise<void>(r=>{secondRelease=r;}));
  release();let done=false;void first.then(()=>{done=true;});
  await new Promise(r=>setTimeout(r,0));assert.equal(done,false);
  secondRelease();await first;assert.equal(done,true);
});
test('media upload validates acknowledgment and retries the same blob bytes',async()=>{
  const input={sessionId:'synthetic',blob:new Blob(['synthetic audio']),type:'recording' as const,filename:'one.webm'};
  const bodies:string[]=[];
  const request:typeof fetch=async(_url,options)=>{
    const blob=(options!.body as FormData).get('file') as Blob;
    bodies.push(await blob.text());
    return bodies.length===1 ? new Response('',{status:503}) : Response.json({url:'/synthetic',path:'synthetic/one.webm',bucket:'recordings'});
  };
  await assert.rejects(uploadInterviewMedia(input,request),/503/);
  await uploadInterviewMedia(input,request);
  assert.deepEqual(bodies,['synthetic audio','synthetic audio']);
  for(const data of [{url:'/wrong'},{url:'/wrong',path:'another/one.webm',bucket:'recordings'},{url:'/wrong',path:'synthetic/one.webm',bucket:'screenshots'}]) {
    await assert.rejects(uploadInterviewMedia(input,async()=>Response.json(data)),/本场存储确认/);
  }
});
