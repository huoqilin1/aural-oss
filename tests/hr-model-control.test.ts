import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac} from 'node:crypto';
import {getHrTextPolicy,resolveHrModelChain} from '../server/hr-model-control';
import {callRelayLLM,resetRelayLlmCacheForTests} from '../server/relay-llm';
import {flushHrUsage} from '../server/hr-model-usage-outbox';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
