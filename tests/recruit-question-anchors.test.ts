import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureExplicitRecruitAnchorLead,
  questionReferencesRecruitAnchor,
  recruitAnchorTerms,
  recruitQuestionFitsRoleType,
  safeRecruitAnchorLines,
  selectRecruitAnchor,
  completeRecruitAnchor,
} from "../src/lib/recruit-question-anchors";

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
