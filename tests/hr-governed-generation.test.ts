import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateGovernedText, AllFourModelsFailed } from "../server/relay-llm";
import { HrTaskHalted } from "../server/hr-model-task";
import { flushHrUsage } from "../server/hr-model-usage-outbox";

test("governed generation meters invalid JSON, reaches the fourth model once, then durably stops on total failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-generation-test-"));
  const configuration: Record<string,string> = {
    AURAL_RUNTIME_STATE_DIR:root, HR_MODEL_USAGE_OUTBOX:join(root,"usage"),
    HR_MODEL_CONTROL_URL:"http://127.0.0.1/v1/recruit/internal/aural/model-policy", HR_MODEL_CONTROL_SECRET:"synthetic-secret",
    ZHIPU_API_KEY:"synthetic", KIMI_API_KEY:"synthetic", DEEPSEEK_API_KEY:"synthetic",
    DOUBAO_TEXT_API_KEY:"synthetic", DOUBAO_TEXT_MODEL:"synthetic-doubao",
  };
  const previous = Object.fromEntries(Object.keys(configuration).map(key=>[key,process.env[key]]));
  Object.assign(process.env,configuration);
  const originalFetch = globalThis.fetch;
  const attempts: string[] = [];
  const usage: Array<{id:string;status:string;usage:{prompt_tokens:number;completion_tokens:number}}> = [];
  let failAll = false;
  let state = "active";
  globalThis.fetch = (async (input, options) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(options?.body));
    if (path.endsWith("/model-task")) {
      if (body.action === "failure") state = "halted";
      return Response.json({success:true,task_key:"aural:7",round:1,state,route:{primary:"zhipu",fallbacks:["kimi","deepseek","doubao"]}});
    }
    if (path.endsWith("/model-usage")) {
      usage.push(body); return Response.json({success:true,id:body.id});
    }
    assert.ok(path.endsWith("/chat/completions"));
    assert.ok(options?.signal);
    attempts.push(body.model);
    const content = !failAll && body.model === "synthetic-doubao" ? '{"questions":[1,2,3,4,5,6]}' : "invalid-json";
    return Response.json({choices:[{message:{content}}],usage:{prompt_tokens:17,completion_tokens:3}});
  }) as typeof fetch;
  const identity = {interview_id:"synthetic-interview",stage:"interview.generate_questions"};
  const messages = [{role:"user",content:"synthetic question-generation input"}];
  const validate = (text:string) => assert.equal(JSON.parse(text).questions.length,6);
  try {
    await generateGovernedText(identity,messages,validate);
    assert.deepEqual(attempts,["glm-5.3","kimi-k3","deepseek-v4-pro","synthetic-doubao"]);
    await flushHrUsage();
    assert.equal(new Set(usage.map(row=>row.id)).size,4);
    assert.equal(usage.filter(row=>row.status === "success").length,1);
    assert.ok(usage.every(row=>row.usage.prompt_tokens === 17 && row.usage.completion_tokens === 3));
    failAll = true;
    await assert.rejects(generateGovernedText(identity,messages,validate),AllFourModelsFailed);
    await assert.rejects(generateGovernedText(identity,messages,validate),HrTaskHalted);
    assert.equal(attempts.length,8);
    await flushHrUsage();
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(configuration)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
