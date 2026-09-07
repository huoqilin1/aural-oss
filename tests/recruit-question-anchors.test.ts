import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import {
  ensureExplicitRecruitAnchorLead,
  questionReferencesRecruitAnchor,
  recruitAnchorTerms,
  recruitQuestionFitsRoleType,
  safeRecruitAnchorLines,
  selectRecruitAnchor,
  completeRecruitAnchor,
  recruitQuestionAnchorFailure,
} from "../src/lib/recruit-question-anchors";

test("job anchors prefer responsibilities over unrelated numeric experience requirements", () => {
  const job="拓展地方政府客户、推进合同落地\n3-5年商务/BD经验";
  assert.equal(selectRecruitAnchor(job,["工具","技术"],false),"拓展地方政府客户、推进合同落地");
  assert.equal(selectRecruitAnchor(job,["商务"],false),"3-5年商务/BD经验");
  assert.equal(selectRecruitAnchor(job,["工具","技术"]),"3-5年商务/BD经验");
});

test("question failures distinguish missing anchors and wrong role without disclosing source data", () => {
  const anchors={resume:"负责客户服务和合同核对",job:"推进政府客户合作与合同落地"};
  assert.equal(recruitQuestionAnchorFailure("请介绍你的经历",undefined,false),"question_anchor_source_missing");
  assert.equal(recruitQuestionAnchorFailure("岗位需要推进政府客户合作",anchors,false),"question_resume_anchor_missing");
  assert.equal(recruitQuestionAnchorFailure("简历写到客户服务和合同核对，请介绍",anchors,false),"question_job_anchor_missing");
  const valid=`简历写到“${anchors.resume}”，岗位要求“${anchors.job}”，请推演如何核对合作条款。`;
  assert.equal(recruitQuestionAnchorFailure(valid,anchors,false),null);
  assert.equal(recruitQuestionAnchorFailure(valid+"请写SQL查询",anchors,false),"question_role_mismatch");
  assert.equal(recruitQuestionAnchorFailure(valid+"请写SQL查询",anchors,true),null);
});

test("actual generation prompt selects work evidence and actual provider validator rejects broken questions", () => {
  const source=readFileSync("src/app/api/v1/interviews/[id]/generate-questions/route.ts","utf8");
  const tree=ts.createSourceFile("route.ts",source,ts.ScriptTarget.Latest,true);
  let validator="";
  function visit(node:ts.Node){
    if(ts.isCallExpression(node)&&node.expression.getText(tree)==="generateGovernedText") validator=node.arguments[2].getText(tree);
    ts.forEachChild(node,visit);
  }
  visit(tree);assert.ok(validator);
  const context=vm.createContext({
    selectRecruitAnchor,recruitAnchorTerms,recruitQuestionAnchorFailure,ensureExplicitRecruitAnchorLead,
    jobTitle:"政企商务",jobDescription:"拓展地方政府客户并推动合同落地\n3-5年商务/BD经验",
    resumeText:"使用销售台账复核每笔退款记录",durationMinutes:22,resumeQuestions:4,jobQuestions:4,
    expertExamples:[],preserveOpening:true,preserveDimensions:["core_experience","project_ownership"],
    contractVersion:"v12",roleType:"nontechnical_core",evidenceV11:true,isTechnicalRole:false,
  });
  const code=source.slice(source.indexOf("const LEGACY_RECRUIT_DIMENSIONS"),source.indexOf("async function interviewAccessError"))
    +source.slice(source.indexOf("function buildRecruitPrompt"),source.indexOf("export async function POST"))
    +source.slice(source.indexOf("  const anchorKeywords:"),source.indexOf("  const { data: initialRows"))
    +`\nconst selectedDimensions=recruitDimensions(contractVersion);const batchDimensions=selectedDimensions.filter(d=>!preserveDimensions.includes(d));const persistedTexts=new Set();globalThis.check=${validator};globalThis.input=messages;globalThis.pairs=Object.fromEntries(anchors);`;
  vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const input=context.input as Array<{role:string;content:string}>;
  assert.equal(input.at(-2)?.role,"system");
  assert.ok(input.at(-2)?.content.includes("保留引文中的数字、年限、范围、单位和术语"));
  const pairs=JSON.parse(input.at(-1)!.content) as Record<string,{resume:string;job:string}>;
  assert.equal(Object.keys(pairs).length,6);
  assert.equal(pairs.core_skill_evidence.job,"拓展地方政府客户并推动合同落地");
  const questions=Object.entries(pairs).map(([dimension,pair])=>({dimension,text:`你在简历中写到“${pair.resume}”，岗位要求“${pair.job}”，请说明具体做法？`}));
  // Distinct dimension wording is required independently from correct anchors.
  questions.forEach((q,i)=>{q.text+=`请选择第${i+1}种情境分析。`;});
  context.check(JSON.stringify({questions}));
  const bad=structuredClone(questions);
  bad[0].text=`你在简历中写到“${pairs.core_skill_evidence.resume}”，请说明具体做法？`;
  assert.throws(()=>context.check(JSON.stringify({questions:bad})),/question_job_anchor_missing_core_skill_evidence/);
  bad[0].text=questions[0].text+"请写SQL查询";
  assert.throws(()=>context.check(JSON.stringify({questions:bad})),/question_role_mismatch_core_skill_evidence/);
});

test("resume anchor never truncates the 72nd character into a broken claim", () => {
  const line = "参与过跨部门协作，" + "定期复核招聘数据并记录修改依据".repeat(6);
  assert.equal(completeRecruitAnchor(line), "参与过跨部门协作");
  assert.equal(completeRecruitAnchor("参与招聘流程(简历筛选，邀约"), "");
  assert.equal(completeRecruitAnchor("参与招聘数据核对，每周汇总数据(简历量、"), "参与招聘数据核对");
  const complete = "负责" + "招聘资料核对和审查".repeat(9);
  assert.equal(completeRecruitAnchor(complete), complete);
});

test("generated evidence questions receive the exact explicit resume and job lead", () => {
  const lead = "你在简历中写到“负责政府客户项目”，而岗位要求中强调“推进项目交付”。";
  const generated = "请说明政府客户项目中推进交付的具体行动和验收结果。";

  assert.equal(
    ensureExplicitRecruitAnchorLead(generated, lead),
    `${lead}${generated}`,
  );
});

test("already explicit evidence questions are not prefixed twice", () => {
  const lead = "你在简历中写到“负责客户项目”，而岗位要求中强调“推进交付”。";
  const generated = "你提到负责客户项目，请说明推进交付时的本人贡献。";

  assert.equal(ensureExplicitRecruitAnchorLead(generated, lead), generated);
});

test("recruit anchors select concrete evidence while excluding contact fields", () => {
  const resume = [
    "姓名：测试候选人",
    "手机：13800138000",
    "邮箱：candidate@example.com",
    "负责订单系统重构，使用 TypeScript 和 PostgreSQL 将接口错误率降低 40%",
    "参与团队例会和日常协作",
  ].join("\n");

  assert.deepEqual(safeRecruitAnchorLines(resume), [
    "负责订单系统重构，使用 TypeScript 和 PostgreSQL 将接口错误率降低 40%",
    "参与团队例会和日常协作",
  ]);
  assert.equal(
    selectRecruitAnchor(resume, ["项目", "负责", "系统", "交付"]),
    "负责订单系统重构，使用 TypeScript 和 PostgreSQL 将接口错误率降低 40%",
  );
});

test("anchor cleanup preserves leading experience years and rejects broken fragments", () => {
  assert.deepEqual(
    safeRecruitAnchorLines("3年以上招聘经验\n1、负责候选人全流程沟通\n年以上相关经验"),
    ["3年以上招聘经验", "负责候选人全流程沟通"],
  );
});

test("anchor pairing exposes shared concrete terms and protects nontechnical roles", () => {
  assert.ok(recruitAnchorTerms("负责招聘流程与候选人沟通").includes("招聘"));
  assert.equal(
    recruitQuestionFitsRoleType("请给出一页招聘交付方案和验收方式", false),
    true,
  );
  assert.equal(
    recruitQuestionFitsRoleType("请现场写 SQL 查询并给出数据库表结构", false),
    false,
  );
  assert.equal(
    recruitQuestionFitsRoleType("请现场写 SQL 查询并给出数据库表结构", true),
    true,
  );
});

test("generated questions must reference both selected resume and job anchors", () => {
  const resumeAnchor = "负责订单系统重构，接口错误率降低40%";
  const jobAnchor = "负责核心交易接口的稳定性与故障排查";
  const grounded = "你在订单系统重构中如何处理接口错误？岗位要求核心交易接口稳定性，请现场推演。";
  const generic = "你在简历中提到相关项目，请结合岗位要求说明。";

  assert.equal(questionReferencesRecruitAnchor(grounded, resumeAnchor), true);
  assert.equal(questionReferencesRecruitAnchor(grounded, jobAnchor), true);
  assert.equal(questionReferencesRecruitAnchor(generic, resumeAnchor), false);
  assert.equal(questionReferencesRecruitAnchor(generic, jobAnchor), false);
});

test("complete short-term job requirements are valid anchors without a four-character Chinese run", () => {
  const anchor="沟通、抗压、协作";
  assert.equal(questionReferencesRecruitAnchor('岗位要求“沟通、抗压、协作”，请说明相关经历。',anchor),true);
  assert.equal(questionReferencesRecruitAnchor('岗位要求沟通/抗压/协作，请说明相关经历。',anchor),true);
  assert.equal(questionReferencesRecruitAnchor('请说明你的沟通经历。',anchor),false);
  assert.equal(questionReferencesRecruitAnchor('请说明相关工作。','工作'),false);
});
