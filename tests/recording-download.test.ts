import assert from 'node:assert/strict';
import test from 'node:test';
import {allowedRecordingUrl,fetchRecordingDownload} from '../src/lib/voice/recording-download';

const storage=['https://synthetic-storage.example'];
const valid=storage[0]+'/storage/v1/object/sign/recordings/synthetic/recording-123.webm?token=synthetic';
test('signed recording paths accept legacy names and content hash names',()=>{
  assert.ok(allowedRecordingUrl(valid,storage));
  assert.ok(allowedRecordingUrl(valid.replace('recording-123', 'a'.repeat(64)),storage));
});
test('arbitrary servers, internal targets and other storage buckets are rejected before fetch',async()=>{
  let requests=0;
  const request:typeof fetch=async()=>{requests++;return new Response('unexpected');};
  for (const url of ['http://127.0.0.1/private','http://169.254.169.254/latest/meta-data',
    valid.replace('synthetic-storage.example','synthetic-storage.example.attacker.example'),
    valid.replace('/recordings/','/screenshots/'),valid.replace('?token=synthetic',''),
    valid.replace('https://','file://'),valid.replace('https://','https://user:password@'),
    valid.replace('recording-123.webm','%2f..%2fprivate'),valid+'#fragment']) {
    assert.equal((await fetchRecordingDownload(url,storage,request)).status,400);
  }
  assert.equal(requests,0);
});
test('missing or invalid configured storage does not enable a general download proxy',()=>{
  assert.equal(allowedRecordingUrl(valid,[]),null);
  assert.equal(allowedRecordingUrl(valid,[undefined,'invalid']),null);
});
test('redirect responses are never followed to another server',async()=>{
  let calls=0;
  const response=await fetchRecordingDownload(valid,storage,async(_url,options)=>{
    calls++;assert.equal(options?.redirect,'manual');
    return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});
  });
  assert.equal(response.status,502);assert.equal(calls,1);
});
test('authorized storage media streams through and storage failures stay failures',async()=>{
  assert.equal(await (await fetchRecordingDownload(valid,storage,async()=>new Response('synthetic audio'))).text(),'synthetic audio');
  assert.equal((await fetchRecordingDownload(valid,storage,async()=>new Response('',{status:403}))).status,403);
});
