import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as anchors from "../src/lib/recruit-question-anchors";

type Row = { id?: string; order: number; text: string; description: string; [key: string]: unknown };
const dimensions = ["core_experience", "project_ownership", "core_skill_evidence", "result_authenticity", "job_work_sample", "problem_solving", "ai_learning_boundary", "collaboration_motivation_stability"];
const questions = ["技能使用", "成果口径", "现场工作样例", "问题排查", "AI学习验证", "职业动机"];
const source = fs.readFileSync("src/app/api/v1/interviews/[id]/generate-questions/route.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const rows: Row[] = dimensions.slice(0, 2).map((dimension, order) => ({ id: `fixed-${order}`, order, text: `固定题${order}`, description: `oprun_dimension:${dimension}` }));
  const requested: string[][] = [];
  let failSecond = false, holdSecond = false, invalid = false, failSave = false, clock = 1000;
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
    "@/lib/logger": { createLogger: () => ({ error() {} }) },
    "@/lib/recruit-question-anchors": anchors,
    "../../../../../../../server/hr-model-task": { HrTaskHalted: class extends Error {} },
    "../../../../../../../server/relay-llm": { AllFourModelsFailed: ModelFailure,
      generateGovernedText: async (_identity: unknown, messages: Array<{ content: string }>, validate: (text: string) => void) => {
        const selected = JSON.parse(messages.at(-1)!.content) as Record<string, { resume: string; job: string }>;
        requested.push(Object.keys(selected));
        if (requested.length === 2) { reached(); if (holdSecond) await blocked; if (failSecond) throw new ModelFailure(); }
        const value = JSON.stringify({ questions: Object.entries(selected).map(([dimension, pair]) => ({ dimension,
          text: invalid ? "请说明工作经历？" : `你在简历中写到“${pair.resume}”，岗位要求“${pair.job}”，请说明${questions[dimensions.indexOf(dimension) - 2]}的实际证据？` })) });
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
  return { rows, requested, request, second, release, setHold: () => { holdSecond = true; }, setFail: (value: boolean) => { failSecond = value; }, setSaveFail: () => { failSave = true; }, setInvalid: () => { invalid = true; }, advanceClock: () => { clock += 181000; } };
}

test("actual route saves Q3/Q4 before later generation and coalesces even after old lock TTL", async () => {
  const h = harness(); h.setHold();
  const pending = h.request(); await h.second;
  assert.equal(h.rows.length, 4);
  assert.deepEqual(h.rows.map(row => row.description), dimensions.slice(0, 4).map(d => `oprun_dimension:${d}`));
  h.advanceClock();
  const duplicate = await h.request();
  assert.equal((await duplicate.json()).data.skipped, "generation_in_progress");
  assert.equal(h.requested.length, 2);
  h.release(); assert.equal((await pending).status, 200);
  assert.deepEqual(h.requested, [dimensions.slice(2, 4), dimensions.slice(4, 6), dimensions.slice(6)]);
  assert.equal(h.rows.length, 9);
  assert.equal(h.rows.at(-1)!.description, "oprun_dimension:candidate_questions");
  assert.equal(h.rows[0].id, "fixed-0"); assert.equal(h.rows[1].id, "fixed-1");
});

test("failed later batch preserves early questions and a later permitted call generates only missing dimensions", async () => {
  const h = harness(); h.setFail(true);
  assert.equal((await h.request()).status, 503); assert.equal(h.rows.length, 4);
  const preserved = JSON.stringify(h.rows);
  h.setFail(false); assert.equal((await h.request()).status, 200);
  assert.equal(JSON.stringify(h.rows.slice(0, 4)), preserved);
  assert.deepEqual(h.requested.slice(2), [dimensions.slice(4, 6), dimensions.slice(6)]);
  assert.equal(h.rows.length, 9);
});

test("unanchored generated questions are rejected before any new rows are saved", async () => {
  const h = harness(); h.setInvalid();
  assert.equal((await h.request()).status, 503); assert.equal(h.rows.length, 2);
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
  assert.equal(JSON.stringify(complete.rows), before); assert.equal(complete.requested.length, 3);
});
