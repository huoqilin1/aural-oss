import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac} from 'node:crypto';
import {getHrTextPolicy,resolveHrModelChain} from '../server/hr-model-control';
import {callRelayLLM,resetRelayLlmCacheForTests} from '../server/relay-llm';
import {flushHrUsage} from '../server/hr-model-usage-outbox';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('HR policy controls consecutive real relay calls and never restores DeepSeek',async()=>{
  const original={...process.env};const oldFetch=globalThis.fetch;
  const directory=await mkdtemp(path.join(os.tmpdir(),'hr-control-test-'));
  try {
    process.env.HR_MODEL_CONTROL_URL='https://hr.example.invalid/v1/recruit/internal/aural/model-policy';
    process.env.HR_MODEL_CONTROL_SECRET='synthetic-control';
    process.env.HR_MODEL_USAGE_OUTBOX=directory;
    process.env.ZHIPU_API_KEY='synthetic';process.env.KIMI_API_KEY='synthetic';process.env.DEEPSEEK_API_KEY='synthetic';
    let primary='zhipu';const models:string[]=[];
    globalThis.fetch=async(input,init)=>{
      if(String(input).includes('model-usage'))return Response.json({success:true,id:JSON.parse(String(init?.body)).id});
      if(String(input).includes('model-policy')) {
        const headers=new Headers(init?.headers);const timestamp=headers.get('X-HR-Model-Timestamp');
        assert.equal(headers.get('X-HR-Model-Signature'),createHmac('sha256','synthetic-control').update(`${timestamp}\nGET\n/v1/recruit/internal/aural/model-policy\n`).digest('hex'));
        return Response.json({success:true,route:{primary,fallbacks:[]},models:{zhipu:'glm-5.3',kimi:'kimi-k3'}});
      }
      models.push(JSON.parse(String(init?.body)).model);
      return Response.json({choices:[{message:{content:'synthetic answer'}}],usage:{prompt_tokens:1,completion_tokens:2}});
    };
    resetRelayLlmCacheForTests();
    assert.equal(await callRelayLLM('synthetic'), 'synthetic answer');
    primary='kimi';assert.equal(await callRelayLLM('synthetic'), 'synthetic answer');
    assert.deepEqual(await resolveHrModelChain(['deepseek-v4-pro','glm-5.3']),['kimi-k3']);
    assert.deepEqual(models,['glm-5.3','kimi-k3']);
    await flushHrUsage();
    globalThis.fetch=async()=>new Response('',{status:503});
    await assert.rejects(callRelayLLM('synthetic'),/control unavailable/);
    await assert.rejects(resolveHrModelChain(['deepseek-v4-pro']),/control unavailable/);
  } finally {
    globalThis.fetch=oldFetch;
    for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];
    Object.assign(process.env,original);resetRelayLlmCacheForTests();
    await rm(directory,{recursive:true,force:true});
  }
});

test('partial bridge configuration and invalid routes cannot use a legacy default',async()=>{
  const original={...process.env};
  try {
    process.env.HR_MODEL_CONTROL_URL='https://hr.example.invalid/policy';delete process.env.HR_MODEL_CONTROL_SECRET;
    await assert.rejects(getHrTextPolicy(),/incomplete/);
    process.env.HR_MODEL_CONTROL_SECRET='synthetic';
    await assert.rejects(getHrTextPolicy(async()=>Response.json({success:true,route:{primary:'unknown',fallbacks:[]}})),/invalid policy/);
  } finally {
    for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];
    Object.assign(process.env,original);
  }
});
