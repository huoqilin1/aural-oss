import {
  apiError,
  isAuthError,
  validateApiKey,
  type ApiKeyAuth,
} from "@/lib/api-key-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getProvider } from "@/lib/ai/registry";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/v1/generate-questions");

// 招聘一面出题:深度思考模型(最新深度版),按岗位+简历提前出题。
// 现场追问走另一条快线(relay-llm,deepseek-v4-flash),不在这里。
const RECRUIT_GENERATOR_MODEL = "deepseek-v4-pro";
// The fixed opening is already usable.  The deep generator (deepseek-v4-pro,
// up to 6000 tokens) routinely needs 10-20s; an 8s budget made it lose the
// race by milliseconds and every session fell back to the blueprint
// template.  25s keeps the full set within the ~30s preparation target the
// candidate perceives (they can already start on the fixed opening), while
// the blueprint stays as the safety net.
const GENERATION_BUDGET_MS = 25_000;
const RECRUIT_DIMENSIONS = [
  "communication",
  "job_duty_primary",
  "job_duty_secondary",
  "core_experience",
  "problem_solving",
  "ai_collaboration",
  "learning",
  "motivation_stability",
] as const;
const RECRUIT_DIMENSION_SET = new Set<string>(RECRUIT_DIMENSIONS);

async function withGenerationBudget<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("generation_budget_exceeded")),
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
  } = opts;
  const preserved = new Set(preserveDimensions);
  if (preserveOpening) preserved.add("communication");
  const remaining = RECRUIT_DIMENSIONS.filter((dimension) => !preserved.has(dimension));
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
  return [
    {
      role: "system" as const,
      content: `你是一位资深的招聘一面出题官。请为一位候选人设计 AI 一面（结构化岗位面试）的题目。全部用中文。

要求:
1. 系统已固定写入的维度为 ${Array.from(preserved).join(", ") || "无"}；只生成剩余 ${remaining.length} 道主问题，严禁重复固定题。完整顺序和 dimension 必须严格如下，不得缺项、合并或重复方向:
   1) communication: 用大约 3 分钟自我介绍，观察信息组织与表达；
   2) job_duty_primary: 核验岗位最核心职责；
   3) job_duty_secondary: 核验岗位另一项重要职责或跨团队协作；
   4) core_experience: 从简历选最相关的一段经历，核验本人职责、行动和量化结果；
   5) problem_solving: 用具体复杂场景考察分析、取舍与落地；
   6) ai_collaboration: 核验如何用 AI 改造工作，而不是只问是否用过工具；
   7) learning: 核验学习速度、复盘和迁移能力；
   8) motivation_stability: 核验求职动机、岗位理解与稳定性。
2. 每题都要结合岗位或简历中的具体证据；简历没有的信息不得臆造。
3. 全部用 OPEN_ENDED 类型，一题只考一个主要方向；不同题不得换一种说法重复追问同一段经历。
4. 整场目标约 ${durationMinutes} 分钟，系统全场最多只允许 2 次追问，因此主问题必须独立、完整、可直接作答。${expertBlock ? `
5. 下面给了资深面试官(王总/凌总等专家)在本岗位问过的「经典问答范例」。请学习这些范例的提问深度、角度和挖人方式,出题向这个水准看齐——可借鉴角度,但要结合本候选人简历,不要照抄。` : ""}

只输出合法 JSON,不要 markdown、不要解释:
{
  "questions": [
    { "order": 0, "text": "题面", "dimension": "communication" }
  ]
}`,
    },
    {
      role: "user" as const,
      content: `岗位名称: ${jobTitle || "(未提供)"}

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
  const preserveOpening = body.preserveOpening === true;
  const preserveDimensions = Array.isArray(body.preserveDimensions)
    ? Array.from(new Set(body.preserveDimensions.flatMap((value) => {
        const dimension = typeof value === "string" ? value.trim() : "";
        return RECRUIT_DIMENSION_SET.has(dimension) ? [dimension] : [];
      })))
    : [];
  if (preserveOpening && !preserveDimensions.includes("communication")) {
    preserveDimensions.unshift("communication");
  }

  if (!jobTitle && !resumeText) {
    return apiError("BAD_REQUEST", "jobTitle 或 resumeText 至少要有一个", 400);
  }

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
    });
    const resp = await withGenerationBudget(
      provider.generateResponse({
        messages,
        temperature: 0.5,
        maxTokens: preserveDimensions.length ? 4500 : 6000,
        model: RECRUIT_GENERATOR_MODEL,
      }),
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
  const blueprint: Array<{ key: string; fallback: string; seconds: number }> = [
    {
      key: "communication",
      fallback: "请先花大约 3 分钟做自我介绍，重点说明与你申请岗位最相关的经历、成果和你承担的职责。",
      seconds: 180,
    },
    {
      key: "job_duty_primary",
      fallback: `围绕${jobTitle || "这个岗位"}最核心的职责，请举一个你独立完成类似任务的具体案例。`,
      seconds: 210,
    },
    {
      key: "job_duty_secondary",
      fallback: `在${jobTitle || "相关工作"}中需要跨团队协作时，你如何明确目标、处理分歧并推动结果？请讲一个具体案例。`,
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
      fallback: `你为什么选择${jobTitle || "这个岗位"}，哪些工作内容最吸引你，哪些现实情况可能影响你的长期投入？`,
      seconds: 180,
    },
  ];
  const generatedByDimension = new Map(
    rawQs.flatMap((question) => {
      const key = typeof question.dimension === "string" ? question.dimension.trim() : "";
      const text = typeof question.text === "string" ? question.text.trim() : "";
      return key && text ? [[key, text] as const] : [];
    }),
  );
  const usedQuestionTexts = new Set<string>();
  const questions = blueprint
    .filter((item) => !preserveDimensions.includes(item.key))
    .map((item, index) => {
    const generatedText = generatedByDimension.get(item.key);
    let text =
      item.key === "communication" && (!generatedText || !/自我介绍|介绍一下/.test(generatedText))
        ? item.fallback
        : generatedText || item.fallback;
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
}
