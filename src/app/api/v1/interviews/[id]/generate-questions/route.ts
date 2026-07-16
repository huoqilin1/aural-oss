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
}) {
  const {
    jobTitle,
    jobDescription,
    resumeText,
    durationMinutes,
    resumeQuestions,
    jobQuestions,
    expertExamples,
  } = opts;
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
      content: `你是一位资深的招聘一面出题官。请为一位候选人设计一面("测试",对外一律称"测试",绝不说"面试")的题目。全部用中文。

要求:
1. 题目按顺序分三部分:
   - 第 1 题固定是自我介绍:让候选人用大约 3 分钟做自我介绍(这是重要的开场,必须保留)。
   - 接着 ${resumeQuestions} 道【简历题】:针对候选人简历里真实写到的经历、项目、技能逐点深挖(他亲手做了什么、关键数字、踩过的坑、取舍判断)。只问简历真有的,不凭空编。
   - 再 ${jobQuestions} 道【岗位题】:针对岗位"${jobTitle}"该具备的能力出题,考察能不能胜任。
2. 全部用 OPEN_ENDED 类型(语音对话测试,不要选择题、不要编程题)。
3. 每题短、具体、一题一个点,像资深挑剔的考官。
4. 整场大约 ${durationMinutes} 分钟。${expertBlock ? `
5. 下面给了资深面试官(王总/凌总等专家)在本岗位问过的「经典问答范例」。请学习这些范例的提问深度、角度和挖人方式,出题向这个水准看齐——可借鉴角度,但要结合本候选人简历,不要照抄。` : ""}

只输出合法 JSON,不要 markdown、不要解释:
{
  "questions": [
    { "order": 0, "text": "题面", "section": "intro" }
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
请生成这场一面测试的题目,输出 JSON。`,
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
      : 22;
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

  if (!jobTitle && !resumeText) {
    return apiError("BAD_REQUEST", "jobTitle 或 resumeText 至少要有一个", 400);
  }

  let generated: { questions?: Array<{ text?: unknown }> };
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
    });
    const resp = await provider.generateResponse({
      messages,
      temperature: 0.5,
      maxTokens: 8000,
      model: RECRUIT_GENERATOR_MODEL,
    });
    generated = parseJsonSafe(resp.content) as { questions?: Array<{ text?: unknown }> };
  } catch (err) {
    log.error("招聘出题失败:", err);
    return apiError("INTERNAL_ERROR", "AI 出题失败", 500);
  }

  const rawQs = Array.isArray(generated?.questions) ? generated.questions : [];
  const texts: string[] = rawQs
    .map((q) => (typeof q.text === "string" ? q.text.trim() : ""))
    .filter((t) => t.length > 0);

  // 兜底:第 1 题必须是自我介绍(AI 没放对就强制补到最前)
  const introLike =
    texts[0] && /自我介绍|介绍一下自己|介绍一下你自己/.test(texts[0]);
  if (!introLike) {
    texts.unshift("请先花大约 3 分钟做个自我介绍,聊聊你的背景、经历和你最拿得出手的事。");
  }
  if (texts.length === 0) {
    return apiError("INTERNAL_ERROR", "AI 没出有效题目", 500);
  }

  const { data: maxRow } = await supabaseAdmin
    .from("questions")
    .select("order")
    .eq("interviewId", interviewId)
    .order("order", { ascending: false })
    .limit(1)
    .maybeSingle();

  let nextOrder = (maxRow?.order ?? -1) + 1;
  const rows = texts.map((text) => ({
    interviewId,
    order: nextOrder++,
    text,
    type: "OPEN_ENDED",
    isRequired: true,
    options: null,
    probeOnShort: true,
  }));
  // 候选人反问环节(2026-06-27 王总拍板):一面最后让候选人问小君;小君收集问题、不追问候选人(probeOnShort=false),答疑交给二面 HR
  rows.push({
    interviewId,
    order: nextOrder++,
    text: "最后,你有没有什么想了解的?关于岗位、团队、公司,想问的都可以说出来,我会记下来,二面的时候 HR 会当面跟你详细解答。",
    type: "OPEN_ENDED",
    isRequired: false,
    options: null,
    probeOnShort: false,
  });

  const { data: created, error } = await supabaseAdmin
    .from("questions")
    .insert(rows)
    .select("id");

  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }

  return Response.json({ data: { count: created?.length ?? 0 } });
}
