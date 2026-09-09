import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { GlmPreOutputOverload, overloadDelay, waitForGlm } from '../server/glm-overload-retry';
import { callRelayLLM, AllFourModelsFailed } from '../server/relay-llm';
import { flushHrUsage } from '../server/hr-model-usage-outbox';

test('overload bounds, Retry-After and cancellation',async()=>{
 assert.equal(overloadDelay(new GlmPreOutputOverload(0),0,0),15000);
 assert.equal(overloadDelay(new GlmPreOutputOverload(0),1,15000),30000);
 assert.equal(overloadDelay(new GlmPreOutputOverload(0),2,45000),null);
 assert.equal(overloadDelay(new GlmPreOutputOverload(60),1,60000),null);
 assert.equal(overloadDelay(new Error('LLM API 429 code=1305'),0,0),null);
 await assert.rejects(waitForGlm(15000,AbortSignal.abort()),{name:'AbortError'});
});

for(const failures of [1,3]) test(`physical attempts and released capacity with ${failures} overloads`,async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'glm-overload-'));
 const settings={RECRUIT_GLM_ONLY:'1',RECRUIT_TEST_MODEL_ROUTING:'0',ZHIPU_BASE_URL:'https://open.bigmodel.cn/api/coding/paas/v4',ZHIPU_API_KEY:'synthetic',HR_MODEL_USAGE_OUTBOX:join(root,'usage'),HR_MODEL_CONTROL_URL:'http://127.0.0.1/v1/recruit/internal/aural/model-policy',HR_MODEL_CONTROL_SECRET:'synthetic',GLM_SHARED_CAPACITY_ENABLED:'1'};
 const old=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));Object.assign(process.env,settings);
 const original=globalThis.fetch;let calls=0,active=0;const events:any[]=[];
 globalThis.fetch=(async(input,options)=>{
  const url=String(input),body=JSON.parse(String(options?.body));
  if(url.endsWith('/model-capacity')){
   if(body.action==='acquire')active++;
   if(body.action==='release')active--;
   return Response.json({success:true,granted:body.action!=='release'});
  }
  if(url.endsWith('/model-usage')){events.push(body);return Response.json({success:true,id:body.id});}
  calls++;assert.equal(active,1);
  return calls<=failures?Response.json({error:{code:'1305'}},{status:429}):Response.json({choices:[{message:{content:'valid'}}],usage:{prompt_tokens:2,completion_tokens:3}});
 }) as typeof fetch;
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  const pending=callRelayLLM('synthetic',undefined,undefined,{primary:'zhipu',fallbacks:[]});
  const outcome=pending.then(value=>({value}),error=>({error}));
  for(let round=0;round<2;round++){
   const deadline=performance.now()+5000;
   while(events.length<round+1 && performance.now()<deadline)await setImmediate();
   assert.ok(events.length>=round+1,'physical attempt persisted before advancing time');
   for(let i=0;i<10;i++)await setImmediate();
   assert.equal(active,0,'capacity released before backoff');
   t.mock.timers.tick(round===0?15000:30000);
  }
  const result=await outcome;
  if(failures===3)assert.ok('error' in result && result.error instanceof AllFourModelsFailed);
  else assert.deepEqual(result,{value:'valid'});
  await flushHrUsage();
  assert.equal(calls,Math.min(failures+1,3));
  const unique=Array.from(new Map(events.map(e=>[e.id,e])).values());
  assert.equal(unique.length,calls);assert.equal(new Set(unique.map(e=>e.call_id)).size,1);
  assert.ok(unique.filter(e=>e.status==='failed').every(e=>e.usage===null));
 }finally{
  t.mock.timers.reset();globalThis.fetch=original;
  for(const k of Object.keys(settings)){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
 }
});
