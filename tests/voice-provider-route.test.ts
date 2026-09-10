import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVoiceRoute, parseVoiceRoute, offlineVoiceEndpoint, loadVoiceRoute, synthesizeOffline } from '../server/voice-provider-route';

test('test speech stays offline even when production is paid',()=>{
  assert.deepEqual(selectVoiceRoute(true,{VOICE_PRODUCTION_PROVIDER:'volcengine'}),{provider:'offline',test:true});
  assert.throws(()=>parseVoiceRoute({provider:'volcengine',test:true}));
  assert.deepEqual(selectVoiceRoute(false,{}),{provider:'volcengine',test:false});
  assert.deepEqual(selectVoiceRoute(false,{VOICE_PRODUCTION_PROVIDER:'offline'}),{provider:'offline',test:false});
});
test('offline synthesis failure never contacts a paid host',async()=>{
  const original=globalThis.fetch;
  const calls:string[]=[];
  globalThis.fetch=async(input)=>{calls.push(String(input));return new Response('',{status:503});};
  try {
    await assert.rejects(async()=>{for await(const event of synthesizeOffline('synthetic')) void event;});
    assert.deepEqual(calls,['http://127.0.0.1:5211/tts']);
  } finally {globalThis.fetch=original;}
});
test('persisted interview route wins over changed defaults and read failures fail closed',async()=>{
  const client=(data:unknown,error:unknown=null)=>({from:()=>({select:()=>({eq:()=>({single:async()=>({data,error})})})})});
  const saved={customBranding:{oprunVoiceRoute:{provider:'offline',test:true}}};
  assert.deepEqual(await loadVoiceRoute(client(saved) as never,'test'),saved.customBranding.oprunVoiceRoute);
  await assert.rejects(()=>loadVoiceRoute(client(null,new Error('db')) as never,'test'));
  assert.deepEqual(await loadVoiceRoute(client({customBranding:{}}) as never,'legacy'),{provider:'volcengine',test:false});
});
test('offline endpoints cannot point to a paid provider',()=>{
  const previous=process.env.OFFLINE_VOICE_URL;
  try {
    for(const url of ['https://example.com','http://example.com','http://127.0.0.1:5211?x=1']){
      process.env.OFFLINE_VOICE_URL=url;
      assert.throws(()=>offlineVoiceEndpoint('tts'));
    }
    process.env.OFFLINE_VOICE_URL='http://127.0.0.1:5211';
    assert.equal(offlineVoiceEndpoint('asr'),'ws://127.0.0.1:5211/asr');
  } finally {if(previous===undefined)delete process.env.OFFLINE_VOICE_URL;else process.env.OFFLINE_VOICE_URL=previous;}
});
