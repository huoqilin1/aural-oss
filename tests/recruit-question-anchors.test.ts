import assert from "node:assert/strict";
import test from "node:test";

import {
  questionReferencesRecruitAnchor,
  recruitAnchorTerms,
  recruitQuestionFitsRoleType,
  safeRecruitAnchorLines,
  selectRecruitAnchor,
} from "../src/lib/recruit-question-anchors";

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
