import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { validateReport } from "../src/lib/ai/validate-report";
import { extractJson } from "../src/lib/ai/extract-json";
import { createClient } from "@supabase/supabase-js";

test("report update acknowledgement distinguishes zero rows using the real Supabase client", async () => {
  for (const rows of [[], [{ id: "qa" }]]) {
    let requests = 0;
    const client = createClient("http://127.0.0.1:9", "synthetic-local-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        requests++;
        const url = new URL(String(input));
        assert.equal(url.origin, "http://127.0.0.1:9");
        assert.equal(init?.method, "PATCH");
        assert.equal(url.searchParams.get("id"), "eq.qa");
        assert.equal(url.searchParams.get("select"), "id");
        assert.match(new Headers(init?.headers).get("prefer") ?? "", /return=representation/);
        assert.equal(new Headers(init?.headers).get("accept"), "application/vnd.pgrst.object+json");
        return rows.length === 1 ? Response.json(rows[0]) : Response.json({
          code: "PGRST116", details: "The result contains 0 rows",
          message: "JSON object requested, multiple (or no) rows returned",
        }, { status: 406 });
      } },
    });
    const saved = await client.from("sessions").update({ summary: "Synthetic report" })
      .eq("id", "qa").select("id").maybeSingle();
    assert.equal(requests, 1);
    assert.equal(saved.error, null);
    assert.equal(saved.data?.id === "qa", rows.length === 1);
  }
});

test("report parsing preserves valid JSON containing quoted evidence and code fences", () => {
  for (const summary of [
    'Evidence says “ownership”, with “P95”: still to verify.',
    'A snippet ```json\\n{ "example": true }\\n``` is quoted evidence.',
    'An escaped "quote", a backslash \\ and a newline\nare evidence.',
  ]) {
    const report = { summary, themes: ["evidence"] };
    const raw = JSON.stringify(report);
    for (const wrapped of [raw, "```json\n" + raw + "\n```", "Report:\n" + raw]) {
      assert.deepEqual(extractJson(wrapped), report);
    }
  }
});

test("report parsing retains legacy repair but rejects truncated JSON", () => {
  assert.deepEqual(extractJson('{“summary”: “Synthetic report”}'), { summary: "Synthetic report" });
  assert.throws(() => extractJson('{"summary":"incomplete'));
});

test("report formatting repair preserves evidence while removing only structural trailing commas", () => {
  const summary = 'Evidence says “P95”: unknown; code ```json {"x": 1} ```; literal ,} and ,] stay.\nNext line.';
  const raw = '{"summary":' + JSON.stringify(summary).replace('\\n', '\n')
    + ',"themes":["evidence",],"details":{"quote":"literal ,}",},}';
  assert.deepEqual(extractJson(raw), {
    summary, themes:["evidence"], details:{quote:"literal ,}"},
  });
  for (const partial of ['{"summary":"complete text","details":[{"x":1}', '{"summary":"missing outer close","themes":[1,2]']) {
    assert.throws(()=>extractJson(partial), "format repair must not invent missing braces or fields");
  }
});

test("report validation rejects absent or empty report bodies", () => {
  for (const value of [null, [], {}, { summary: "  " }, { summary: 12 }]) {
    assert.throws(() => validateReport(value), /report_summary_missing/);
  }
  assert.doesNotThrow(() => validateReport({ summary: "Synthetic evidence-based report" }));
});

for (const entry of [
  { path: "../src/lib/ai/voice-summary.ts", name: "generateVoiceSummary", stage: "interview.voice_report" },
  { path: "../src/app/api/ai/summarize/route.ts", name: "POST", stage: "interview.summary_report" },
]) {
  test(`${entry.stage} image rejection enters the governed text route and preserves save failures`, async () => {
    const source = ts.createSourceFile("report.ts", readFileSync(new URL(entry.path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === entry.name)!;
    let legacyCalls = 0, governedCalls = 0, failSave = false, missingSave = false;
    const messages = [{ contentType: "TEXT", role: "USER", content: "Synthetic answer" }, { contentType: "WHITEBOARD", whiteboardData: { label: "Synthetic diagram" }, whiteboardImageUrl: "data:image/png;base64,cWE=" }];
    const row = { interview: { title: "数君招聘 · Synthetic", userId: "qa", questions: [] }, messages };
    const context = vm.createContext({
      Error, Response, NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
      getAuthUser: async () => ({ id: "qa" }),
      supabaseAdmin: { from: (table: string) => {
        let saving = false;
        const query = {
          select: () => query, eq: () => query, order: () => query,
          update: () => { saving = true; return query; },
          single: async () => ({ data: row }),
          maybeSingle: async () => ({ data: missingSave ? null : { id: "qa" }, error: failSave ? { message: "synthetic storage failure" } : null }),
          then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: table === "messages" ? messages : row, error: saving && failSave ? { message: "synthetic storage failure" } : null }).then(resolve),
        };
        return query;
      } },
      svgDataUrlToPng: async (value: string) => value,
      buildSummaryPrompt: (...args: unknown[]) => args,
      REPORT_MODEL: "qa-vision", REPORT_FALLBACK_CHAIN: [],
      generateWithFallback: async () => { legacyCalls++; throw new Error("vision not supported"); },
      generateGovernedText: async (task: { stage: string }, _messages: unknown, validate: (text: string) => void) => {
        governedCalls++; assert.equal(task.stage, entry.stage);
        const text = JSON.stringify({ summary: "Synthetic persisted summary" }); validate(text); return text;
      },
      extractJson: JSON.parse, validateReport, log: { info() {}, error() {} },
    });
    vm.runInContext(ts.transpileModule(fn.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const invoke = () => vm.runInContext(entry.name === "POST" ? 'POST({ json: async () => ({ sessionId: "qa" }) })' : 'generateVoiceSummary("qa", "数君招聘 · Synthetic")', context) as Promise<Response | void>;
    const success = await invoke();
    if (success) assert.equal(success.status, 200);
    assert.equal(legacyCalls, 1); assert.equal(governedCalls, 1);
    failSave = true;
    if (entry.name === "POST") assert.equal((await invoke() as Response).status, 500);
    else await assert.rejects(invoke(), /report_storage_failed/);
    assert.equal(legacyCalls, 2); assert.equal(governedCalls, 2);
    failSave = false;
    missingSave = true;
    if (entry.name === "POST") assert.equal((await invoke() as Response).status, 500);
    else await assert.rejects(invoke(), /report_storage_failed/);
    assert.equal(legacyCalls, 3); assert.equal(governedCalls, 3);
  });
}

test("report recovery enforces ownership, completion, storage acknowledgement and lost-ack deduplication", async () => {
  const source = ts.createSourceFile("route.ts", readFileSync(new URL("../src/app/api/v1/sessions/[id]/report/route.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const post = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "POST")!;
  const row = { status: "COMPLETED", summary: "", interview: { projectId: "owned", title: "数君招聘 · Synthetic", questions: [] } };
  let authorized = true, failSave = false, calls = 0;
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
  const context = vm.createContext({ Response, validateReport,
    validateApiKey: async () => authorized ? { projectIds: ["owned"] } : new Response(null, { status: 401 }),
    isAuthError: (value: unknown) => value instanceof Response,
    apiError: (_code: string, _message: string, status: number) => new Response(null, { status }),
    supabaseAdmin: { from: () => query },
    generateVoiceSummary: async () => { calls++; if (failSave) throw new Error("storage unavailable"); row.summary = "Synthetic persisted report"; },
  });
  vm.runInContext(ts.transpileModule(post.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const invoke = () => vm.runInContext('POST({}, { params: Promise.resolve({id:"synthetic"}) })', context) as Promise<Response>;
  authorized = false;
  assert.equal((await invoke()).status, 401);
  authorized = true; row.interview.projectId = "other";
  assert.equal((await invoke()).status, 403);
  row.interview.projectId = "owned"; row.status = "ACTIVE";
  assert.equal((await invoke()).status, 409);
  assert.equal(calls, 0);
  row.status = "COMPLETED"; failSave = true;
  assert.equal((await invoke()).status, 503);
  failSave = false;
  assert.equal((await invoke()).status, 200);
  assert.equal((await invoke()).status, 200);
  assert.equal(calls, 2);
});

test("report recovery normalizes complete saved evaluations without paying for regeneration and rejects a lost storage acknowledgement", async () => {
  const source = ts.createSourceFile("route.ts", readFileSync(new URL("../src/app/api/v1/sessions/[id]/report/route.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const post = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "POST")!;
  const items=Array.from({length:8},(_,i)=>({question:`Q${i+1}`,score:4,evaluation:'Synthetic evidence.'}));
  const row={id:'synthetic',status:'COMPLETED',summary:'Saved summary',insights:{questionEvaluations:{note:'Not independently verified.',items}} as Record<string,unknown>,interview:{projectId:'owned',title:'数君招聘 · Synthetic',questions:items}};
  let calls=0, writes=0, missing=false, updating=false;
  const query={select:()=>query,eq:()=>query,update:(patch:{insights:Record<string,unknown>})=>{updating=true;writes++;if(!missing)row.insights=patch.insights;return query;},maybeSingle:async()=>({data:updating&&missing?null:row,error:null})};
  const context=vm.createContext({Response,validateReport,
    validateApiKey:async()=>({projectIds:['owned']}),isAuthError:()=>false,
    apiError:(_code:string,_message:string,status:number)=>new Response(null,{status}),
    supabaseAdmin:{from:()=>{updating=false;return query;}},
    generateVoiceSummary:async()=>{calls++;},
  });
  vm.runInContext(ts.transpileModule(post.getText(source).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const invoke=()=>vm.runInContext('POST({}, {params:Promise.resolve({id:"synthetic"})})',context) as Promise<Response>;
  missing=true;assert.equal((await invoke()).status,503);assert.equal(calls,0);
  missing=false;assert.equal((await invoke()).status,200);assert.equal(calls,0);
  assert.equal(row.insights.questionEvaluations,items);
  assert.equal(row.insights.questionEvaluationsNote,'Not independently verified.');
  assert.equal((await invoke()).status,200);assert.equal(writes,2);assert.equal(calls,0);
  row.insights={questionEvaluations:items.slice(1)};
  assert.equal((await invoke()).status,200);assert.equal(calls,1);
});
