import {
  apiError,
  isAuthError,
  validateApiKey,
  type ApiKeyAuth,
} from "@/lib/api-key-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getProvider } from "@/lib/ai/registry";
import { createLogger } from "@/lib/logger";
import {
  questionReferencesRecruitAnchor,
  selectRecruitAnchor,
} from "@/lib/recruit-question-anchors";

const log = createLogger("api/v1/generate-questions");

// 重入锁：平台 attempt 重试（指数退避最长 6 小时）可能再次触发出题。
// 同一面试的生成进行中时直接跳过，避免并发深度生成白烧 Token。
// 单进程部署下进程内 Map 足够；TTL 兜底防止异常路径漏删。
const generationInFlight = new Map<string, number>();
const GENERATION_LOCK_TTL_MS = 180_000;

// 招聘一面出题:深度思考模型,按岗位+简历提前出题。现场追问走 relay-llm,不在这里。
// 模型策略(王总 2026-08-20):DeepSeek 固定写死"深思考"变体(三档中锁深思考,禁止漂移);
// 其余模型追最新版。环境变量 RECRUIT_GENERATOR_MODEL 可覆盖,升级改 env 即生效。核查日期 2026-08-20。
const RECRUIT_GENERATOR_MODEL = process.env.RECRUIT_GENERATOR_MODEL?.trim() || "deepseek-v4-pro";
// The fixed opening is already usable.  The deep generator (deepseek-v4-pro,
// up to 6000 tokens) routinely needs 10-20s; an 8s budget made it lose the
// race by milliseconds and every session fell back to the blueprint
// template.  150s aligns with the real parallel window: the candidate spends 2-3
// minutes on the fixed opening (self-intro), so the deep generation completes
// invisibly in the background (王总 2026-08-20: the budget hides behind the
// self-intro; Q2 uses the backup question only if generation is late, and
// Q3+ are guaranteed custom because Q1+Q2 exceed the window). The platform
// caller timeout was raised to 180s (AURAL_TIMEOUT) to match.
// candidate perceives (they can already start on the fixed opening), while
// the blueprint stays as the safety net.
const GENERATION_BUDGET_MS = 150_000;
const LEGACY_RECRUIT_DIMENSIONS = [
  "communication",
  "job_duty_primary",
  "job_duty_secondary",
  "core_experience",
  "problem_solving",
  "ai_collaboration",
  "learning",
  "motivation_stability",
] as const;
const EVIDENCE_V11_RECRUIT_DIMENSIONS = [
  "core_experience",
  "project_ownership",
  "core_skill_evidence",
  "result_authenticity",
  "job_work_sample",
  "problem_solving",
  "ai_learning_boundary",
  "collaboration_motivation_stability",
] as const;
function isEvidenceV11(questionSetVersion: string): boolean {
  return questionSetVersion.includes("v11")
    || questionSetVersion.includes("v12")
    || questionSetVersion.includes("scored8-inline3-dynamic1-work-sample")
    || questionSetVersion.includes("scored8-inline2-dynamic1-work-sample");
}

function recruitDimensions(questionSetVersion: string): readonly string[] {
  return isEvidenceV11(questionSetVersion)
    ? EVIDENCE_V11_RECRUIT_DIMENSIONS
    : LEGACY_RECRUIT_DIMENSIONS;
}

async function withGenerationBudget<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`generation_budget_exceeded (budget=${GENERATION_BUDGET_MS}ms)`)),
          GENERATION_BUDGET_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseJsonSafe(raw: string): unknown {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in AI output");
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    let repaired = jsonMatch[0].replace(/,\s*$/, "");
    const opens =
      (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
    const braces =
      (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < opens; i++) repaired += "]";
    for (let i = 0; i < braces; i++) repaired += "}";
    return JSON.parse(repaired);
  }
}

async function interviewAccessError(
  auth: ApiKeyAuth,
  interviewId: string,
): Promise<Response | null> {
  const { data: row } = await supabaseAdmin
    .from("interviews")
    .select("projectId")
    .eq("id", interviewId)
    .maybeSingle();

  if (!row) {
    return apiError("NOT_FOUND", "Interview not found", 404);
  }
  if (!row.projectId || !auth.projectIds.includes(row.projectId)) {
    return apiError("FORBIDDEN", "No access to this interview", 403);
  }
  return null;
}

function buildRecruitPrompt(opts: {
  jobTitle: string;
  jobDescription: string;
  resumeText: string;
  durationMinutes: number;
  resumeQuestions: number;
  jobQuestions: number;
  expertExamples?: Array<{ question?: string; answer?: string }>;
  preserveOpening?: boolean;
  preserveDimensions?: string[];
  questionSpecVersion?: string;
  roleType?: string;
}) {
  const {
    jobTitle,
    jobDescription,
    resumeText,
    durationMinutes,
    resumeQuestions,
    jobQuestions,
    expertExamples,
    preserveOpening,
    preserveDimensions = [],
    questionSpecVersion = "",
    roleType = "nontechnical_core",
  } = opts;
  const dimensions = recruitDimensions(questionSpecVersion);
  const evidenceV11 = isEvidenceV11(questionSpecVersion);
  const preserved = new Set(preserveDimensions);
  if (preserveOpening) preserved.add(dimensions[0]);
  const remaining = dimensions.filter((dimension) => !preserved.has(dimension));
  const expertBlock =
    expertExamples && expertExamples.length
      ? expertExamples
          .map(
            (e, i) =>
              `范例${i + 1}｜问:${(e.question || "").slice(0, 300)}
　　答(好回答长这样):${(e.answer || "").slice(0, 300)}`,
          )
          .join(`
`)
      : "";
  const blueprintInstruction = evidenceV11
    ? `完整顺序和 dimension 必须严格如下，不得缺项、合并或重复方向:
   1) core_experience: 约2分钟计分自我介绍，梳理经历主线和岗位相关能力；
   2) project_ownership: 核验简历核心项目的本人职责、交付边界和上下游；
   3) core_skill_evidence: 核验简历核心技能的真实使用、选择依据和验证方法；
   4) result_authenticity: 核验结果数据口径、本人贡献、失败限制和复盘；
   5) job_work_sample: 必须是岗位现场/假设情境工作样例，要求候选人实际分析、处理或推演；
   6) problem_solving: 核验复杂问题、故障排查、证据顺序、方案取舍和回归；
   7) ai_learning_boundary: 核验AI和工具的实际工作流、学习验证、错误案例和风险边界；
   8) collaboration_motivation_stability: 核验协作交付、求职动机、时间线和现实条件。
3. 第2至第8题每题都必须明确引用简历的一个具体锚点和岗位的一个具体要求；简历没有直接证据时，明确说“简历尚未体现该项”，询问迁移准备和现实差距，禁止臆造。
4. 技术岗位允许并要求核验必要的代码、接口、数据流、配置、日志、指标、架构或验证细节，但不考冷门术语；非技术岗位核验工具、流程、文档、数据口径、交付物和验收方式。
5. 第5题必须是工作样例，不能只问“做过没有”；题面只保留一个核心任务，运行时再根据证据缺口有限追问。
6. 八道主问题之外，全场最多2次就地证据核验和1次可选最终动态核验，因此主问题应清晰、可在2至3分钟内回答。`
    : `完整顺序和 dimension 必须严格如下，不得缺项、合并或重复方向:
   1) communication: 用大约 3 分钟自我介绍，观察信息组织与表达；
   2) job_duty_primary: 核验岗位最核心职责；
   3) job_duty_secondary: 核验岗位另一项重要职责或跨团队协作；
   4) core_experience: 从简历选最相关的一段经历，核验本人职责、行动和量化结果；
   5) problem_solving: 用具体复杂场景考察分析、取舍与落地；
   6) ai_collaboration: 核验如何用 AI 改造工作，而不是只问是否用过工具；
   7) learning: 核验学习速度、复盘和迁移能力；
   8) motivation_stability: 核验求职动机、岗位理解与稳定性。
3. 全部用 OPEN_ENDED 类型，一题只考一个主要方向；不同题不得换一种说法重复追问同一段经历。
4. 整场目标约 ${durationMinutes} 分钟，主问题必须独立、完整、可直接作答。`;
  return [
    {
      role: "system" as const,
      content: `你是一位资深的招聘一面出题官。请为一位候选人设计 AI 一面（结构化岗位面试）的题目。全部用中文。

要求:
1. 题目契约版本为 ${questionSpecVersion || "legacy"}。系统已固定写入的维度为 ${Array.from(preserved).join(", ") || "无"}；只生成剩余 ${remaining.length} 道主问题，严禁重复固定题。
2. ${blueprintInstruction}
3. 每题都要结合岗位或简历中的具体证据；简历没有的信息不得臆造。岗位题与简历题的目标配比为 ${jobQuestions}:${resumeQuestions}，但必须服从当前题目契约的固定八维结构。
4. 题目整体难度为中等：能区分真做过的人和背概念的人，但不刻意刁难。
5. 岗位名称缺失时，用“你应聘的岗位”或直接描述工作内容，严禁用公司名代替岗位名。
6. 像真人 HR 一样得体提问：严禁把候选人的离职状态、在职状态或空窗状态当作未经确认的提问前提；考察动机与稳定性时，直接问职业选择、岗位理解和未来规划本身。
${expertBlock ? `
7. 下面给了资深面试官(王总/凌总等专家)在本岗位问过的「经典问答范例」。请学习这些范例的提问深度、角度和挖人方式,出题向这个水准看齐——可借鉴角度,但要结合本候选人简历,不要照抄。` : ""}

只输出合法 JSON,不要 markdown、不要解释:
{
  "questions": [
    { "order": 0, "text": "题面", "dimension": "${dimensions[0]}" }
  ]
}`,
    },
    {
      role: "user" as const,
      content: `岗位名称: ${jobTitle || "(未提供)"}
岗位类型: ${roleType || "nontechnical_core"}

--- 岗位描述 ---
${jobDescription || "(未提供岗位描述,按岗位名称常识出题)"}
--- 岗位描述结束 ---

--- 候选人简历 ---
${resumeText || "(简历为空,只按岗位出题)"}
--- 候选人简历结束 ---
${expertBlock ? `
--- 资深面试官经典问答范例(学这个深度和角度)---
${expertBlock}
--- 范例结束 ---
` : ""}
请生成这场 AI 一面的题目,输出 JSON。`,
    },
  ];
}

function isCandidateFacingQuestionText(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 420) return false;
  if (/(?:^|[（(\s])(?:第\s*[一二三四五六七八九十\d]+\s*题|Q\s*\d+)|dimension|题目契约|完整题目蓝图|本轮出题规则|系统固定|计分规则|AI评价权重|出题官|严禁|不得为了凑比例/i.test(text)) {
    return false;
  }
  return /[？?]|请|说说|谈谈|说明|还原|分析|推演|介绍/.test(text);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { id: interviewId } = await params;

  const denied = await interviewAccessError(auth, interviewId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError("BAD_REQUEST", "Invalid JSON body", 400);
  }

  const jobTitle =
    typeof body.jobTitle === "string" ? body.jobTitle.trim() : "";
  const jobDescription =
    typeof body.jobDescription === "string" ? body.jobDescription : "";
  const resumeText =
    typeof body.resumeText === "string" ? body.resumeText : "";
  const durationMinutes =
    typeof body.durationMinutes === "number" && body.durationMinutes > 0
      ? body.durationMinutes
      : 30;
  const resumeQuestions =
    typeof body.resumeQuestions === "number" && body.resumeQuestions >= 0
      ? Math.floor(body.resumeQuestions)
      : 4;
  const jobQuestions =
    typeof body.jobQuestions === "number" && body.jobQuestions >= 0
      ? Math.floor(body.jobQuestions)
      : 4;
  const expertExamples = Array.isArray(body.expertExamples)
    ? (body.expertExamples as Array<{ question?: string; answer?: string }>).slice(0, 8)
    : [];
  const questionSetVersion = typeof body.questionSetVersion === "string"
    ? body.questionSetVersion.trim()
    : "";
  const questionSpecVersion = typeof body.questionSpecVersion === "string"
    ? body.questionSpecVersion.trim()
    : "";
  // New clients send an explicit human-readable contract version while the
  // opaque question-set hash remains dedicated to idempotency. Fall back to
  // the legacy field so older integrations keep working.
  const contractVersion = questionSpecVersion || questionSetVersion;
  const roleType = typeof body.roleType === "string"
    ? body.roleType.trim().toLocaleLowerCase()
    : "nontechnical_core";
  const selectedDimensions = recruitDimensions(contractVersion);
  const selectedDimensionSet = new Set(selectedDimensions);
  const preserveOpening = body.preserveOpening === true;
  const preserveDimensions = Array.isArray(body.preserveDimensions)
    ? Array.from(new Set(body.preserveDimensions.flatMap((value) => {
        const dimension = typeof value === "string" ? value.trim() : "";
        return selectedDimensionSet.has(dimension) ? [dimension] : [];
      })))
    : [];
  const openingDimension = selectedDimensions[0];
  if (preserveOpening && !preserveDimensions.includes(openingDimension)) {
    preserveDimensions.unshift(openingDimension);
  }

  if (!jobTitle && !resumeText) {
    return apiError("BAD_REQUEST", "jobTitle 或 resumeText 至少要有一个", 400);
  }

  const lockNow = Date.now();
  const lockStarted = generationInFlight.get(interviewId);
  if (lockStarted && lockNow - lockStarted < GENERATION_LOCK_TTL_MS) {
    return Response.json({ data: { count: 0, skipped: "generation_in_progress" } });
  }
  generationInFlight.set(interviewId, lockNow);

  try {
  let generated: { questions?: Array<{ text?: unknown; dimension?: unknown }> };
  try {
    const provider = getProvider(RECRUIT_GENERATOR_MODEL);
    const messages = buildRecruitPrompt({
      jobTitle,
      jobDescription,
      resumeText,
      durationMinutes,
      resumeQuestions,
      jobQuestions,
      expertExamples,
      preserveOpening,
      preserveDimensions,
      questionSpecVersion: contractVersion,
      roleType,
    });
    const resp = await withGenerationBudget(
      provider.generateResponse({
        messages,
        temperature: 0.5,
        // 思考型模型会把输出预算全部烧在隐藏思考通道、正文为空（实测
        // tokens_out=2048/8000 两次打满且无 JSON）。出题的"深度"已编码在
        // 提示词（维度骨架+专家范例+难度要求），此处显式关思考直出 JSON。
        maxTokens: 4000,
        disableThinking: true,
        model: RECRUIT_GENERATOR_MODEL,
      }),
    );
    log.info(
      `generate-questions usage: model=${RECRUIT_GENERATOR_MODEL} ` +
      `tokens_in=${resp.usage?.promptTokens ?? "?"} ` +
      `tokens_out=${resp.usage?.completionTokens ?? "?"} ` +
      `budget_ms=${GENERATION_BUDGET_MS}`,
    );
    generated = parseJsonSafe(resp.content) as {
      questions?: Array<{ text?: unknown; dimension?: unknown }>;
    };
  } catch (err) {
    log.error("招聘出题失败:", err);
    // A provider failure must not strand a candidate after the fixed opening.
    // The deterministic blueprint below is a complete, usable fallback.
    generated = { questions: [] };
  }

  const rawQs = Array.isArray(generated?.questions) ? generated.questions : [];
  const evidenceV11 = isEvidenceV11(contractVersion);
  const isTechnicalRole = roleType === "technical" || /(?:技术|开发|研发|运维|算法|数据|工程师|架构|程序)/i.test(
    `${jobTitle}\n${jobDescription}`,
  );
  const workSampleInstruction = isTechnicalRole
    ? "请现场给出最小可行方案，包括输入输出、关键数据流，以及必要的伪代码、SQL或配置，并列出至少两项验收或回归检查。"
    : "请现场给出一页可执行交付方案，包括目标、处理步骤、使用的材料或工具、结果指标、主要风险和验收方式。";
  const anchorKeywords: Record<string, { resume: string[]; job: string[] }> = {
    project_ownership: {
      resume: ["项目", "负责", "交付", "系统", "产品", "客户"],
      job: ["职责", "负责", "交付", "项目", "目标"],
    },
    core_skill_evidence: {
      resume: ["技能", "技术", "工具", "开发", "熟悉", "使用"],
      job: ["技能", "能力", "要求", "工具", "技术"],
    },
    result_authenticity: {
      resume: ["成果", "提升", "降低", "增长", "指标", "完成", "%"],
      job: ["产出", "结果", "指标", "目标", "负责"],
    },
    job_work_sample: {
      resume: ["项目", "负责", "交付", "运营", "开发", "分析"],
      job: ["职责", "产出", "负责", "交付", "项目"],
    },
    problem_solving: {
      resume: ["问题", "故障", "优化", "难点", "改进", "项目"],
      job: ["问题", "解决", "质量", "风险", "负责"],
    },
    ai_learning_boundary: {
      resume: ["AI", "人工智能", "大模型", "自动化", "学习", "工具"],
      job: ["AI", "人工智能", "学习", "工具", "效率", "质量"],
    },
    collaboration_motivation_stability: {
      resume: ["协作", "团队", "沟通", "管理", "工作", "负责"],
      job: ["协作", "沟通", "团队", "岗位", "负责"],
    },
  };
  const anchors = new Map(Object.entries(anchorKeywords).map(([dimension, keywords]) => [
    dimension,
    {
      resume: selectRecruitAnchor(resumeText, keywords.resume),
      job: selectRecruitAnchor(
        jobDescription
          .split("【本轮出题规则】", 1)[0]
          .replace("【岗位职责】", "")
          .trim() || jobTitle,
        keywords.job,
      ) || jobTitle,
    },
  ]));
  const anchorLead = (dimension: string): string => {
    const selected = anchors.get(dimension) || { resume: "", job: jobTitle };
    const resumeLead = selected.resume
      ? `你在简历中写到“${selected.resume}”`
      : "你的简历尚未体现与该项直接对应的经历";
    const jobLead = selected.job
      ? `岗位要求中强调“${selected.job}”`
      : `你申请的是“${jobTitle || "当前岗位"}”`;
    return `${resumeLead}，而${jobLead}。`;
  };
  const legacyBlueprint: Array<{ key: string; fallback: string; seconds: number }> = [
    {
      key: "communication",
      fallback: "请先花大约 3 分钟做自我介绍，重点说明与你申请岗位最相关的经历、成果和你承担的职责。",
      seconds: 180,
    },
    {
      key: "job_duty_primary",
      fallback: `围绕${jobTitle && !jobTitle.includes("数君") ? jobTitle : "你应聘的岗位"}最核心的职责，请举一个你独立完成类似任务的具体案例。`,
      seconds: 210,
    },
    {
      key: "job_duty_secondary",
      fallback: `在${jobTitle && !jobTitle.includes("数君") ? jobTitle : "相关工作"}中需要跨团队协作时，你如何明确目标、处理分歧并推动结果？请讲一个具体案例。`,
      seconds: 210,
    },
    {
      key: "core_experience",
      fallback: "请选择一段与本岗位最相关的经历，说明你本人负责什么、采取了哪些行动，以及结果如何量化。",
      seconds: 210,
    },
    {
      key: "problem_solving",
      fallback: "请讲一个信息不完整但必须快速决策的复杂问题，你如何分析、取舍并验证结果？",
      seconds: 210,
    },
    {
      key: "ai_collaboration",
      fallback: "请讲一个你用 AI 改造真实工作流程的案例：原流程是什么、你如何设计协同、效果如何验证？",
      seconds: 210,
    },
    {
      key: "learning",
      fallback: "请讲一次你在短时间内掌握新领域并用于实际工作的经历，你如何学习、复盘并迁移方法？",
      seconds: 180,
    },
    {
      key: "motivation_stability",
      fallback: `你为什么选择${jobTitle && !jobTitle.includes("数君") ? jobTitle : "这个岗位"}，哪些工作内容最吸引你，哪些现实情况可能影响你的长期投入？`,
      seconds: 180,
    },
  ];
  const evidenceV11Blueprint: Array<{ key: string; fallback: string; seconds: number }> = [
    {
      key: "core_experience",
      fallback: "请先花大约2分钟做自我介绍，重点说明与你申请岗位最相关的一段经历、你本人承担的职责、关键行动和可验证结果。",
      seconds: 150,
    },
    {
      key: "project_ownership",
      fallback: `${anchorLead("project_ownership")}请还原你本人负责的模块或交付边界、上下游以及最终交付；若没有直接经历，请说明最接近的真实经历和现实差距。`,
      seconds: 150,
    },
    {
      key: "core_skill_evidence",
      fallback: `${anchorLead("core_skill_evidence")}请选择其中最关键的一项技能，说明你在真实任务中如何使用、为什么这样选择以及如何验证；若没有直接证据，请说明准备和差距。`,
      seconds: 150,
    },
    {
      key: "result_authenticity",
      fallback: `${anchorLead("result_authenticity")}请说明相关成果的指标口径、实施前后变化、你的个人贡献、失败限制和复盘；如果没有量化数据，请说明实际验收证据。`,
      seconds: 150,
    },
    {
      key: "job_work_sample",
      fallback: `${anchorLead("job_work_sample")}现在做一个现场工作样例：${workSampleInstruction}`,
      seconds: 150,
    },
    {
      key: "problem_solving",
      fallback: `${anchorLead("problem_solving")}请现场推演一次相关故障或异常的排查顺序、证据、取舍、修复和回归。`,
      seconds: 150,
    },
    {
      key: "ai_learning_boundary",
      fallback: `${anchorLead("ai_learning_boundary")}请说明你使用AI或快速学习的实际工作流、验证方法、错误案例以及不用AI的边界。`,
      seconds: 150,
    },
    {
      key: "collaboration_motivation_stability",
      fallback: `${anchorLead("collaboration_motivation_stability")}请说明一次真实协作、你的求职动机、时间线和可能影响长期投入的现实条件。`,
      seconds: 120,
    },
  ];
  const blueprint = evidenceV11 ? evidenceV11Blueprint : legacyBlueprint;
  const generatedByDimension = new Map(
    rawQs.flatMap((question) => {
      const key = typeof question.dimension === "string" ? question.dimension.trim() : "";
      const text = typeof question.text === "string" ? question.text.trim() : "";
      return key && isCandidateFacingQuestionText(text) ? [[key, text] as const] : [];
    }),
  );
  const usedQuestionTexts = new Set<string>();
  const questions = blueprint
    .filter((item) => !preserveDimensions.includes(item.key))
    .map((item) => {
    const generatedText = generatedByDimension.get(item.key);
    const selectedAnchors = anchors.get(item.key);
    const evidenceAnchoredGenerated = Boolean(
      !evidenceV11
      || item.key === "core_experience"
      || (
        generatedText
        && selectedAnchors
        && questionReferencesRecruitAnchor(generatedText, selectedAnchors.resume)
        && questionReferencesRecruitAnchor(generatedText, selectedAnchors.job)
      )
    );
    let text =
      item.key === (evidenceV11 ? "core_experience" : "communication")
        && (!generatedText || !/自我介绍|介绍一下/.test(generatedText))
        ? item.fallback
        : evidenceAnchoredGenerated && generatedText
          ? generatedText
          : item.fallback;
    const normalized = text.toLocaleLowerCase().replace(/[\s，。！？、；：,.!?;:()（）【】\[\]"“”'‘’]/g, "");
    if (usedQuestionTexts.has(normalized)) text = item.fallback;
    usedQuestionTexts.add(
      text.toLocaleLowerCase().replace(/[\s，。！？、；：,.!?;:()（）【】\[\]"“”'‘’]/g, ""),
    );
    return { ...item, text };
    });

  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from("questions")
    .select("order,description,text")
    .eq("interviewId", interviewId)
    .order("order", { ascending: true });
  if (existingError) {
    return apiError("INTERNAL_ERROR", existingError.message, 500);
  }
  const existingDimensions = new Set(
    (existingRows ?? []).flatMap((row) => {
      const description = typeof row.description === "string" ? row.description : "";
      return description.startsWith("oprun_dimension:")
        ? [description.slice("oprun_dimension:".length)]
        : [];
    }),
  );
  const missingPreservedDimensions = preserveDimensions.filter(
    (dimension) => !existingDimensions.has(dimension),
  );
  if (missingPreservedDimensions.length) {
    return apiError(
      "CONFLICT",
      `preserveDimensions missing existing questions: ${missingPreservedDimensions.join(",")}`,
      409,
    );
  }

  const { data: maxRow } = await supabaseAdmin
    .from("questions")
    .select("order")
    .eq("interviewId", interviewId)
    .order("order", { ascending: false })
    .limit(1)
    .maybeSingle();

  let nextOrder = (maxRow?.order ?? -1) + 1;
  const rows = questions
    .filter((question) => !existingDimensions.has(question.key))
    .map((question) => ({
    interviewId,
    order: nextOrder++,
    text: question.text,
    description: `oprun_dimension:${question.key}`,
    type: "OPEN_ENDED",
    isRequired: true,
    options: null,
    probeOnShort: true,
    timeLimitSeconds: question.seconds,
  }));
  // 候选人反问环节(2026-06-27 王总拍板):一面最后让候选人问小君;小君收集问题、不追问候选人(probeOnShort=false),答疑交给二面 HR
  if (!existingDimensions.has("candidate_questions")) rows.push({
    interviewId,
    order: nextOrder++,
    text: "最后,你有没有什么想了解的?关于岗位、团队、公司,想问的都可以说出来,我会记下来,二面的时候 HR 会当面跟你详细解答。",
    type: "OPEN_ENDED",
    isRequired: false,
    options: null,
    probeOnShort: false,
    description: "oprun_dimension:candidate_questions",
    timeLimitSeconds: 90,
  });

  if (rows.length === 0) {
    return Response.json({ data: { count: 0 } });
  }

  const { data: created, error } = await supabaseAdmin
    .from("questions")
    .insert(rows)
    .select("id");

  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }

  return Response.json({ data: { count: created?.length ?? 0 } });
  } finally {
    generationInFlight.delete(interviewId);
  }
}
