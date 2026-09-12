import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as anchors from "../src/lib/recruit-question-anchors";

type Row = { id?: string; order: number; text: string; description: string; [key: string]: unknown };
const dimensions = ["core_experience", "project_ownership", "core_skill_evidence", "result_authenticity", "job_work_sample", "problem_solving", "ai_learning_boundary", "collaboration_motivation_stability"];
const batches = [dimensions.slice(2,3), dimensions.slice(3,5), dimensions.slice(5,7), dimensions.slice(7)];
const questions = ["技能使用", "成果口径", "现场工作样例", "问题排查", "AI学习验证", "职业动机"];
const source = fs.readFileSync("src/app/api/v1/interviews/[id]/generate-questions/route.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(keyed = false, shape = "standard") {
  const rows: Row[] = dimensions.slice(0, 2).map((dimension, order) => ({ id: `fixed-${order}`, order, text: `固定题${order}`, description: `oprun_dimension:${dimension}` }));
  const requested: string[][] = [];
  let failSecond = false, holdSecond = false, invalid = false, references = false, failSave = false, clock = 1000;
  let release = () => {}, reached = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const second = new Promise<void>(resolve => { reached = resolve; });
  class ModelFailure extends Error {}
  const db = { from(table: string) {
    let insert: Row[] | undefined;
    const chain = {
      select() { return chain; }, eq() { return chain; }, order() { return chain; }, limit() { return chain; },
      insert(value: Row[]) { insert = value; return chain; },
      async maybeSingle() { return { data: table === "interviews" ? { projectId: "project" } : rows.at(-1), error: null }; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        if (insert && failSave) return Promise.resolve({ data: null, error: { message: "storage unavailable" } }).then(resolve, reject);
        const data = insert ? insert.map(row => { const created = { ...row, id: `generated-${rows.length}` }; rows.push(created); return created; }) : rows.map(row => ({ ...row }));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  } };
  const modules: Record<string, unknown> = {
    "@/lib/api-key-auth": { validateApiKey: async () => ({ projectIds: ["project"] }), isAuthError: () => false,
      apiError: (code: string, message: string, status: number) => Response.json({ code, message }, { status }) },
    "@/lib/supabase/admin": { supabaseAdmin: db },
    "@/lib/logger": { createLogger: () => ({ error() {}, warn() {} }) },
    "@/lib/recruit-question-anchors": anchors,
    "../../../../../../../server/hr-model-task": { HrTaskHalted: class extends Error {} },
    "../../../../../../../server/relay-llm": { AllFourModelsFailed: ModelFailure,
      generateGovernedText: async (_identity: unknown, messages: Array<{ role:string; content: string }>, validate: (text: string) => void) => {
        const selected = JSON.parse(messages.filter(message=>message.role==='user').at(-1)!.content) as Record<string, { resume: string; job: string }>;
        assert.equal(messages.at(-1)!.role,'system');
        const resumeMessage = messages.find(message => message.role === 'user' && message.content.includes('--- 候选人简历 ---'))!;
        assert.ok(resumeMessage.content.includes('questions 必须是对象数组，每项只有 slot 整数和 text 字符串'));
        assert.ok(!resumeMessage.content.includes('每个固定维度键下填写 text'));
        assert.ok(messages.at(-1)!.content.includes('不得用标题、能力名称、考察点、提纲、建议或列表代替问题正文'));
        requested.push(Object.keys(selected));
        if (requested.length === 2) { reached(); if (holdSecond) await blocked; if (failSecond) throw new ModelFailure(); }
        const generated = Object.entries(selected).map(([dimension, pair]) => ({ dimension,
          text: invalid ? "请说明工作经历？" : `你在简历中写到“${references ? "{{resume}}" : pair.resume}”，岗位要求“${references ? "{{job}}" : pair.job}”，请说明${questions[dimensions.indexOf(dimension) - 2]}的实际证据？` }));
        const keyedRows = Object.fromEntries(generated.map(({dimension,text})=>[dimension,{text}]));
        const slots = generated.map(({text},index)=>({slot:index+1,text}));
        if(shape === "slot-missing")slots.pop();
        if(shape === "slot-duplicate")slots.push(slots[0]);
        if(shape === "slot-out-of-range")slots[0].slot=99;
        if(shape === "slot-boolean")(slots[0] as any).slot=true;
        if(shape === "slot-unbound-dimension")(slots[0] as any).dimension=generated[0].dimension;
        const value = JSON.stringify(shape.startsWith("slot") ? {questions:slots}
          : shape === "root-map" ? keyedRows
          : shape === "root-array" ? generated
          : shape === "string-map" ? {questions:Object.fromEntries(generated.map(({dimension,text})=>[dimension,text]))}
          : shape === "single-object" && generated.length === 1 ? {questions:generated[0]}
          : shape === "root-single" && generated.length === 1 ? generated[0]
          : shape === "unknown-dimension" ? {questions:{unknown:generated[0].text}}
          : shape === "missing-dimension" ? {questions:{text:generated[0].text}}
          : { questions: keyed ? keyedRows : generated });
        validate(value); return value;
      },
    },
  };
  const exports: { POST?: (request: Request, context: unknown) => Promise<Response> } = {};
  vm.runInNewContext(compiled, { exports, Response, Date: { now: () => clock }, require: (name: string) => {
    assert.ok(name in modules, `unexpected module ${name}`); return modules[name];
  } });
  const request = () => exports.POST!(new Request("https://example.test/generate", { method: "POST", body: JSON.stringify({
    jobTitle: "客户经理", jobDescription: "负责客户项目交付与风险核验", resumeText: "负责客户项目交付，使用业务工具核验结果并协作复盘",
    roleType: "nontechnical_core", questionSpecVersion: "recruit-interview-v12", preserveOpening: true, preserveDimensions: dimensions.slice(0, 2),
  }) }), { params: Promise.resolve({ id: "interview" }) });
  return { rows, requested, request, second, release, setHold: () => { holdSecond = true; }, setFail: (value: boolean) => { failSecond = value; }, setReferences: () => { references = true; }, setSaveFail: () => { failSave = true; }, setInvalid: () => { invalid = true; }, advanceClock: () => { clock += 181000; } };
}

test("dimension-keyed provider responses persist urgent Q3 and all later dimensions", async () => {
  const h = harness(true); h.setReferences();
  assert.equal((await h.request()).status, 200);
  assert.deepEqual(h.rows.slice(0,8).map(row=>row.description),dimensions.map(d=>`oprun_dimension:${d}`));
  assert.deepEqual(h.requested,batches);
  assert.equal(h.rows.length,9);
});

for (const shape of ["slots", "root-map", "root-array", "string-map", "single-object", "root-single"]) {
  test(`equivalent explicit-dimension JSON ${shape} preserves all eight anchored questions`, async () => {
    const h = harness(true, shape); h.setReferences();
    assert.equal((await h.request()).status, 200);
    assert.deepEqual(h.requested, batches);
    assert.deepEqual(h.rows.slice(0,8).map(row=>row.description), dimensions.map(d=>`oprun_dimension:${d}`));
    assert.ok(h.rows.slice(2,8).every(row=>row.text.includes("负责客户项目交付") && !row.text.includes("{{")));
  });
}
for (const shape of ["slot-missing", "slot-duplicate", "slot-out-of-range", "slot-boolean", "slot-unbound-dimension", "unknown-dimension", "missing-dimension"]) {
  test(`${shape} is never inferred from the requested batch`, async () => {
    const h = harness(true, shape);
    assert.equal((await h.request()).status, 503);
    assert.equal(h.rows.length, 2);
    assert.equal(h.requested.length, 1);
  });
}

test("actual route saves Q3 without waiting for Q4 and coalesces even after old lock TTL", async () => {
  const h = harness(); h.setHold();
  const pending = h.request(); await h.second;
  assert.equal(h.rows.length, 3);
  assert.deepEqual(h.rows.map(row => row.description), dimensions.slice(0, 3).map(d => `oprun_dimension:${d}`));
  h.advanceClock();
  const duplicate = await h.request();
  assert.equal((await duplicate.json()).data.skipped, "generation_in_progress");
  assert.equal(h.requested.length, 2);
  h.release(); assert.equal((await pending).status, 200);
  assert.deepEqual(h.requested, batches);
  assert.equal(h.rows.length, 9);
  assert.equal(h.rows.at(-1)!.description, "oprun_dimension:candidate_questions");
  assert.equal(h.rows[0].id, "fixed-0"); assert.equal(h.rows[1].id, "fixed-1");
});

test("failed later batch preserves early questions and a later permitted call generates only missing dimensions", async () => {
  const h = harness(); h.setFail(true);
  assert.equal((await h.request()).status, 503); assert.equal(h.rows.length, 3);
  const preserved = JSON.stringify(h.rows);
  h.setFail(false); assert.equal((await h.request()).status, 200);
  assert.equal(JSON.stringify(h.rows.slice(0, 3)), preserved);
  assert.deepEqual(h.requested.slice(2), batches.slice(1));
  assert.equal(h.rows.length, 9);
});

test("unanchored generated questions are rejected before any new rows are saved", async () => {
  const h = harness(); h.setInvalid();
  assert.equal((await h.request()).status, 503); assert.equal(h.rows.length, 2);
});

test("actual route saves expanded source references rather than template markers", async () => {
  const h = harness(); h.setReferences();
  assert.equal((await h.request()).status, 200);
  assert.equal(h.rows.length, 9);
  for (const row of h.rows.slice(2, 8)) {
    assert.ok(row.text.includes("负责客户项目交付"));
    assert.ok(row.text.includes("风险核验"));
    assert.ok(!row.text.includes("{{"));
  }
});

test("storage failure stops later paid batches and cannot return success", async () => {
  const h = harness(); h.setSaveFail();
  assert.equal((await h.request()).status, 500);
  assert.equal(h.rows.length, 2); assert.equal(h.requested.length, 1);
});

test("missing preserved questions fail before generation and a complete set is idempotent", async () => {
  const missing = harness(); missing.rows.pop();
  assert.equal((await missing.request()).status, 409); assert.equal(missing.requested.length, 0);
  const complete = harness(); assert.equal((await complete.request()).status, 200);
  const before = JSON.stringify(complete.rows);
  const again = await complete.request(); assert.equal(again.status, 200);
  assert.equal((await again.json()).data.count, 0);
  assert.equal(JSON.stringify(complete.rows), before); assert.equal(complete.requested.length, 4);
});
