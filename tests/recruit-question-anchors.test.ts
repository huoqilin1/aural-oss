import assert from "node:assert/strict";
import test from "node:test";

import {
  questionReferencesRecruitAnchor,
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
