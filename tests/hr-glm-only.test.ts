import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateGovernedText, callRelayLLM, AllFourModelsFailed, safeRelayFailure } from "../server/relay-llm";
import { HrTaskHalted } from "../server/hr-model-task";
import { flushHrUsage } from "../server/hr-model-usage-outbox";

test("anchor failure metadata keeps only fixed cause and dimension without payloads", () => {
  const code = "question_job_anchor_missing_problem_solving";
  assert.equal(safeRelayFailure(new Error(code)), code);
  assert.equal(safeRelayFailure(new Error("question_job_anchor_missing_private_payload")), "Error");
  assert.equal(safeRelayFailure(new Error(code + ": private payload")), "Error");
});

for (const split of [false, true]) test(`model routing preserves one-pass halt with split=${split}`, async () => {
  const root=await mkdtemp(join(tmpdir(),"hr-glm-only-"));
  const configuration:Record<string,string>={RECRUIT_GLM_ONLY:"1",RECRUIT_TEST_MODEL_ROUTING:split?"1":"0",AURAL_RUNTIME_STATE_DIR:root,HR_MODEL_USAGE_OUTBOX:join(root,"usage"),
    HR_MODEL_CONTROL_URL:"http://127.0.0.1/v1/recruit/internal/aural/model-policy",HR_MODEL_CONTROL_SECRET:"synthetic-secret",
    ZHIPU_API_KEY:"synthetic",ZHIPU_MODEL:"glm-old",RELAY_LLM_MODEL:"deepseek-v4-pro",
    KIMI_API_KEY:"synthetic",DEEPSEEK_API_KEY:"synthetic",DOUBAO_TEXT_API_KEY:"synthetic",DOUBAO_TEXT_MODEL:"synthetic-doubao"};
  const previous=Object.fromEntries(Object.keys(configuration).map(key=>[key,process.env[key]]));
  Object.assign(process.env,configuration);
  const originalFetch=globalThis.fetch;
  const calls:string[]=[];
  let state="active",fail=false;
  let acknowledgeFailure:()=>void=()=>{};
  const failureAck=new Promise<void>(resolve=>{acknowledgeFailure=resolve;});
  globalThis.fetch=(async(input,options)=>{
    const path=new URL(String(input)).pathname,body=JSON.parse(String(options?.body));
    if(path.endsWith("/model-task")){
      if(body.action==="failure"){
        assert.deepEqual(body.attempts.map((item:{provider:string})=>item.provider),(split?["deepseek","doubao","kimi","zhipu"]:["zhipu"]));state="halted";acknowledgeFailure();
      }
      return Response.json({success:true,task_key:"aural:9",round:1,state,route:split?{primary:body.stage==="interview.generate_questions"?"deepseek":"doubao",fallbacks:body.stage==="interview.generate_questions"?["doubao","kimi","zhipu"]:["deepseek","kimi","zhipu"]}:{primary:"zhipu",fallbacks:[]}});
    }
    if(path.endsWith("/model-usage"))return Response.json({success:true,id:body.id});
    calls.push(body.model);
    if (split && body.model === "synthetic-doubao" && !fail) assert.deepEqual(body.thinking, {type:"disabled"});
    if (split && body.model === "deepseek-v4-pro") assert.deepEqual(body.thinking, {type:"enabled"});
    if(fail)return new Response("synthetic",{status:429});
    return Response.json({choices:[{message:{content:"valid"}}],usage:{prompt_tokens:2,completion_tokens:2}});
  }) as typeof fetch;
  try{
    assert.equal(await callRelayLLM("synthetic",undefined,undefined,{primary:"kimi",fallbacks:["deepseek","zhipu","doubao"]}),"valid");
    fail=true;
    const operation=()=>generateGovernedText({interview_id:"glm-only",stage:"interview.generate_questions"},[{role:"user",content:"synthetic"}],()=>{});
    await assert.rejects(operation(),AllFourModelsFailed);
    await failureAck;
    await assert.rejects(operation(),HrTaskHalted);
    assert.deepEqual(calls,split?["synthetic-doubao","deepseek-v4-pro","synthetic-doubao","kimi-k3","glm-old"]:["glm-5.3","glm-5.3"]);
    await flushHrUsage();
  }finally{
    globalThis.fetch=originalFetch;
    for(const key of Object.keys(configuration)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  }
});
