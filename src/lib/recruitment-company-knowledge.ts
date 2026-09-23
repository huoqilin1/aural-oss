/** Source-backed public information selected by Wang on 2026-09-10.
 * No candidate records, contacts, inferred benefits or commercial guarantees.
 */
export interface CompanyFact {
  id: string;
  aliases: string[];
  answer: string;
  source: string;
  positions: string[];
  region: string;
  status: "approved" | "draft" | "disabled";
  responseMode: "exact" | "faithful";
  effectiveFrom: string;
  reviewDue: string;
  owner: string;
}
export const COMPANY_KNOWLEDGE_VERSION = "shujun-public-2026-09-10-v1";
const common = {
  region: "", status: "approved" as const, responseMode: "exact" as const,
  effectiveFrom: "2026-09-10", reviewDue: "2026-10-10", owner: "HR：指定公开来源维护",
};
export const COMPANY_FACTS: readonly CompanyFact[] = [
  { ...common, id: "company-intro", positions: [],
    aliases: ["公司介绍", "介绍公司", "公司做什么", "公司是做什么", "主营业务", "主要业务", "公司主要做", "what does your company do", "tell me about the company"],
    answer: "数君科技官网介绍了 OpRun AI 原生组织及易付薪等产品。OpRun 面向企业任务交付，结合 AI 执行与人的判断、协作。",
    source: "https://www.ai.yifx.vip/" },
  { ...common, id: "company-name", positions: [],
    aliases: ["公司全称", "公司叫什么", "公司名称", "company name"],
    answer: "官网列示的公司主体是北京数君科技集团有限公司，品牌名称为数君科技。",
    source: "https://www.ai.yifx.vip/" },
  { ...common, id: "oprun", positions: [],
    aliases: ["oprun是什么", "介绍oprun", "oprun做什么", "主要产品", "有什么产品", "产品有哪些"],
    answer: "OpRun 面向企业任务交付，包含目标拆解、资源匹配和交付验证，结合 AI 执行与 OPC 的判断和协作。官网也列有易付薪产品。",
    source: "https://www.ai.yifx.vip/oprun" },
  { ...common, id: "customers", positions: [],
    aliases: ["服务什么客户", "服务哪些客户", "客户类型", "客户是谁", "面向哪些客户", "主要客户", "客户主要是", "who are your customers"],
    answer: "官网的 OpRun 主要面向有任务交付需求的企业，也面向参与任务承接与协作的 OPC。",
    source: "https://www.ai.yifx.vip/oprun" },
  { ...common, id: "office", positions: [],
    aliases: ["公司地址", "办公地点", "公司在哪里", "办公在哪", "办公室在哪"],
    answer: "官网列示的办公地址位于北京市海淀区清华科技园赛尔大厦；你应聘岗位的具体办公安排需以该岗位确认为准。",
    source: "https://www.ai.yifx.vip/" },
  { ...common, id: "roadshow-role", positions: ["总经理助理（资源对接/产品路演方向）"],
    aliases: ["岗位职责", "主要工作", "这个岗位做什么", "工作内容"],
    answer: "智联该岗位说明主要涉及 AI 产品路演、合作资源对接、新媒体内容协同及出差支持，要求能独立宣讲和答疑。",
    source: "https://www.zhaopin.com/jobdetail/CCL1384021340J40885967105.htm" },
  { ...common, id: "roadshow-travel", positions: ["总经理助理（资源对接/产品路演方向）"],
    aliases: ["出差吗", "需要出差", "出差频率"],
    answer: "智联该岗位说明需要配合出差，但没有给出固定频次，具体安排需由 HR 确认。",
    source: "https://www.zhaopin.com/jobdetail/CCL1384021340J40885967105.htm" },
  { ...common, id: "government-role", positions: ["政府客户销售经理"],
    aliases: ["岗位职责", "主要工作", "这个岗位做什么", "工作内容"],
    answer: "智联该岗位说明主要涉及政府客户拓展、AI 解决方案商务沟通、项目签约及交付协调。",
    source: "https://www.zhaopin.com/jobdetail/CCL1384021340J40885964505.htm" },
];

export function lookupCompanyFact(question: string, position: string, now = new Date(), facts = COMPANY_FACTS) {
  const normalized = question.toLowerCase().replace(/[\s，。！？、,.!?]/g, "");
  const date = now.toISOString().slice(0, 10);
  const matches = facts.filter(f => f.status === "approved" && f.source && f.owner
    && f.effectiveFrom <= date && date <= f.reviewDue && !f.region
    && (!f.positions.length || f.positions.includes(position))
    && f.aliases.some(a => normalized.includes(a.toLowerCase().replace(/\s/g, ""))));
  // Multiple different answers are not silently merged, including broad compound questions.
  if (!matches.length || new Set(matches.map(f => f.answer)).size !== 1) return null;
  return matches[0];
}

// Keep released entries here when publishing a new version. Existing sessions
// may only use their saved version, never silently switch to new company facts.
export const COMPANY_KNOWLEDGE_RELEASES: Readonly<Record<string,readonly CompanyFact[]>> = {
  [COMPANY_KNOWLEDGE_VERSION]: COMPANY_FACTS,
};
export function pinCompanyKnowledge(metadata:unknown):Record<string,unknown> {
  const base=metadata&&typeof metadata==="object"&&!Array.isArray(metadata)?{...metadata as Record<string,unknown>}:{};
  if(typeof base.recruitmentCompanyKnowledgeVersion!=="string")base.recruitmentCompanyKnowledgeVersion=COMPANY_KNOWLEDGE_VERSION;
  return base;
}
export function companyKnowledgeVersion(metadata:unknown):string {
  return String(pinCompanyKnowledge(metadata).recruitmentCompanyKnowledgeVersion);
}
