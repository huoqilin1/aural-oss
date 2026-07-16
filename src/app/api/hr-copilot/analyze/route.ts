import { getProvider } from "@/lib/ai/registry";
import type { LLMMessage } from "@/lib/ai/types";
import { createLogger } from "@/lib/logger";
import { NextResponse } from "next/server";

const log = createLogger("api/hr-copilot/analyze");

// Real-time route: DeepSeek Flash -> DeepSeek Pro -> Kimi fallback.
const MODEL_CHAIN = Array.from(new Set([
  process.env.HR_COPILOT_FLASH_MODEL || "deepseek-v4-flash",
  process.env.HR_COPILOT_PRO_MODEL || "deepseek-v4-pro",
  ...(process.env.HR_COPILOT_FALLBACK_MODELS || "kimi-k2-turbo,moonshot-v1-8k")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean),
]));

type Term = { term: string; plain: string };
type Suspicion = { point: string; suggest: string; evidence?: string };
type Analysis = { terms: Term[]; suspicions: Suspicion[]; hits: number[] };
const EMPTY: Analysis = { terms: [], suspicions: [], hits: [] };

function parseAnalysis(raw: string, checklistLength: number): Analysis {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("MODEL_OUTPUT_NOT_JSON");
  const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, any>;
  const terms = Array.isArray(data.terms)
    ? data.terms.filter((item: any) => item && typeof item.term === "string" && typeof item.plain === "string").slice(0, 12)
    : [];
  const suspicions = Array.isArray(data.suspicions)
    ? data.suspicions.filter((item: any) => item && typeof item.point === "string" && typeof item.suggest === "string").slice(0, 8)
    : [];
  const hits = Array.isArray(data.hits)
    ? data.hits
        .map((value: unknown) => Number(value))
        .filter((value: number) => Number.isInteger(value) && value >= 1 && value <= checklistLength)
    : [];
  return { terms, suspicions, hits };
}

/**
 * HR 二面陪面台「军师」大脑。
 * 输入候选人刚说的一段话 + 候选人简历/一面结论/右栏问题清单,
 * 输出:①行话→大白话翻译 ②可疑点+建议追问 ③这段答到了清单第几条。
 * 只辅助 HR,绝不替 HR 拍板、绝不跟候选人说话。
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(EMPTY);
  }
  const segment = String(body.segment ?? "").trim();
  if (!segment) return NextResponse.json(EMPTY);

  const position = String(body.position ?? "通用岗位");
  const resume = String(body.resume ?? "").slice(0, 2500);
  const oneRoundSummary = String(body.oneRoundSummary ?? "").slice(0, 1200);
  const checklist: string[] = Array.isArray(body.checklist)
    ? (body.checklist as unknown[]).map((q) => String(q)).slice(0, 30)
    : [];

  const sys = `你是数君二面的「HR 军师」,坐在不懂这行的 HR 旁边。候选人正在跟 HR 真人面对面聊,你只在旁边辅助 HR——绝不替 HR 拍板、绝不跟候选人说话、不出题。
候选人应聘岗位:${position}。
读候选人刚说的一段话,严格只返回这个 JSON(不要任何多余文字):
{
 "terms":[{"term":"候选人原话里外行听不懂的专业词/行话","plain":"一句大白话解释,让不懂行的 HR 秒懂"}],
 "suspicions":[{"point":"真有水分的点(吹牛/和简历对不上/概念用错/太空泛回避)","suggest":"建议 HR 追问的一句具体话","evidence":"判这个可疑的依据:简历或一面结论里哪句话对不上、或候选人这段话哪里露的馅(具体引用,别空泛)"}],
 "hits":[这段话答到了下面清单里第几条问题的序号(整数),没答到就空数组]
}
规矩:翻译只翻外行真听不懂的词,常识词不翻;可疑点要克制,只挑真有水分的,没有就给空数组;suggest 要像一句能直接念出口的追问。`;

  const ctx = `【候选人简历(供你判断真假/对不对得上)】\n${resume || "(暂无)"}\n\n【一面结论(供你别重复、接着追)】\n${oneRoundSummary || "(暂无)"}\n\n【HR 右栏问题清单(判断 hits 用)】\n${checklist.length ? checklist.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(暂无)"}`;

  const messages: LLMMessage[] = [
    { role: "system", content: `${sys}\n\n${ctx}` },
    { role: "user", content: `候选人刚说:「${segment}」\n按系统要求只返回那个 JSON。` },
  ];

  const requestId = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
  const attempts: Array<{ model: string; error: string; latencyMs: number }> = [];
  for (let index = 0; index < MODEL_CHAIN.length; index += 1) {
    const model = MODEL_CHAIN[index];
    const startedAt = Date.now();
    try {
      const provider = getProvider(model);
      const resp = await provider.generateResponse({
        messages,
        temperature: model.toLowerCase().includes("kimi") ? 0.6 : 0.2,
        maxTokens: 1500,
        model,
      });
      if (!resp.content.trim()) throw new Error("MODEL_OUTPUT_EMPTY");
      const result = parseAnalysis(resp.content, checklist.length);
      log.info("analyze success", { requestId, model, fallbackUsed: index > 0, latencyMs: Date.now() - startedAt });
      return NextResponse.json({
        success: true,
        ...result,
        model,
        fallbackUsed: index > 0,
        requestId,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      const failure = {
        model,
        error: String(err).slice(0, 200),
        latencyMs: Date.now() - startedAt,
      };
      attempts.push(failure);
      log.warn("analyze model failed", { requestId, ...failure });
    }
  }
  return NextResponse.json({
    success: false,
    error: "ALL_MODELS_FAILED",
    requestId,
    attempts,
  }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
