import assert from 'node:assert/strict';
import test from 'node:test';
import {storeMediaObject, type MediaObjectStore} from '../src/lib/voice/media-object-storage';

const input = {sessionId:'synthetic',bytes:Buffer.from('synthetic audio bytes'),contentType:'audio/webm',extension:'webm' as const};
function storage() {
  const objects = new Map<string,Buffer>();
  let failSigned = false;
  let loseUploadReply = false;
  const api: MediaObjectStore = {
    async upload(path,bytes,options) {
      assert.equal(options.upsert,false);
      if (objects.has(path)) return {error:Error('already exists')};
      objects.set(path,Buffer.from(bytes));
      if (loseUploadReply) throw Error('reply lost');
      return {error:null};
    },
    async download(path) {return {data:objects.has(path) ? new Blob([new Uint8Array(objects.get(path)!)]) : null,error:null};},
    async createSignedUrl(path) {return {data:failSigned ? null : {signedUrl:`/synthetic/${path}`},error:failSigned ? Error('signing unavailable') : null};},
  };
  return {api,objects,setSignedFailure(value:boolean) {failSigned=value;},loseReply() {loseUploadReply=true;}};
}

test('identical retries reuse an immutable object and changed bytes get another path',async () => {
  const store=storage();
  const first=await storeMediaObject(store.api,input);
  assert.deepEqual(await storeMediaObject(store.api,input),first);
  const other=await storeMediaObject(store.api,{...input,bytes:Buffer.from('changed synthetic audio')});
  assert.notEqual(first.path,other.path);
  assert.equal(store.objects.size,2);
});
test('accepted object with lost upload reply is verified before acknowledgment',async () => {
  const store=storage();store.loseReply();
  const result=await storeMediaObject(store.api,input);
  assert.ok(result.url);assert.equal(store.objects.size,1);
});
test('signing failure can be retried without uploading a second object',async () => {
  const store=storage();store.setSignedFailure(true);
  await assert.rejects(storeMediaObject(store.api,input),/URL creation failed/);
  store.setSignedFailure(false);
  await storeMediaObject(store.api,input);
  assert.equal(store.objects.size,1);
});
test('a mismatching existing object is never overwritten or accepted',async () => {
  const store=storage();const first=await storeMediaObject(store.api,input);
  store.objects.set(first.path,Buffer.from('unexpected bytes'));
  await assert.rejects(storeMediaObject(store.api,input),/does not match/);
  assert.equal(store.objects.get(first.path)!.toString(),'unexpected bytes');
});
test('failed upload without a verified object cannot receive a URL',async () => {
  const store=storage();store.api.upload=async () => ({error:Error('offline')});
  await assert.rejects(storeMediaObject(store.api,input),/not confirmed/);
});
test('empty files and session path traversal never reach storage',async () => {
  const store=storage();
  await assert.rejects(storeMediaObject(store.api,{...input,bytes:Buffer.alloc(0)}),/Invalid media/);
  await assert.rejects(storeMediaObject(store.api,{...input,sessionId:'../another'}),/Invalid media/);
  assert.equal(store.objects.size,0);
});
