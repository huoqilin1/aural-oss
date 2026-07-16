import { getProvider } from "@/lib/ai/registry";
import type { LLMMessage } from "@/lib/ai/types";
import { createLogger } from "@/lib/logger";
import { NextResponse } from "next/server";

const log = createLogger("api/hr-copilot/conclude");

// 二面结果用「深度线」出终评,质量优先(HR 面完点一次,等几秒值);DeepSeek 402/不可用时把 RELAY_CONCLUDE_MODEL 切到 deepseek-v4-flash 或 kimi
const MODEL = process.env.RELAY_CONCLUDE_MODEL || "deepseek-v4-pro";

const EMPTY = { recommendation: "", summary: "", highlights: [] as string[], risks: [] as string[] };

/**
 * HR 二面陪面台「二面结果」生成。
 * 面完点一次,基于二面全程转写 + 简历 + 一面结论 + 题清单完成情况,
 * 出一份这场二面的结果草稿:推荐档(通过/待定/不通过)+ 总评 + 亮点 + 风险。
 * 只是给 HR 的参考草稿,HR 可改后存;绝不替 HR 拍板。
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ...EMPTY, error: "请求格式错误" });
  }

  const transcript = String(body.transcript ?? "").slice(0, 12000);
  if (transcript.trim().length < 10) {
    return NextResponse.json({ ...EMPTY, error: "二面全程转写太短,先录一段再生成" });
  }
  const position = String(body.position ?? "通用岗位");
  const resume = String(body.resume ?? "").slice(0, 2500);
  const oneRoundSummary = String(body.oneRoundSummary ?? "").slice(0, 1200);
  const checklist: string[] = Array.isArray(body.checklist)
    ? (body.checklist as unknown[]).map((q) => String(q)).slice(0, 30)
    : [];
  const doneCount = Number(body.done ?? 0);

  const sys = `你是数君二面的「HR 军师」。这场真人二面刚结束,你要基于【二面全程转写 + 候选人简历 + 一面结论 + 题清单完成情况】,给 HR 一份这场二面的结果判断。你只是给 HR 的参考草稿,最终由 HR 拍板;不跟候选人对话、不出题。
候选人应聘岗位:${position}。
严格只返回这个 JSON(不要任何多余文字、不要 markdown 包裹):
{
 "recommendation":"三选一:通过 / 待定 / 不通过",
 "summary":"一句话总评(60字内,说清这人这场二面整体怎么样、值不值得进下一步)",
 "highlights":["这场二面真实暴露的亮点,1-4条,每条一句,具体、对得上他说过的事,别空泛"],
 "risks":["这场二面暴露的风险/存疑/没说清的点,0-4条,每条一句,具体"]
}
判断规矩:只依据二面真实说了什么,没聊到的别编;亮点和风险都要能对上转写里的具体内容;recommendation 综合亮点与风险给,拿不准就给"待定"。`;

  const ctx = `【二面全程转写】\n${transcript}\n\n【候选人简历(供对照真假)】\n${resume || "(暂无)"}\n\n【一面结论(供别重复、接着看)】\n${oneRoundSummary || "(暂无)"}\n\n【二面题清单(共 ${checklist.length} 题,已答约 ${doneCount} 题)】\n${checklist.length ? checklist.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(暂无)"}`;

  const messages: LLMMessage[] = [
    { role: "system", content: `${sys}\n\n${ctx}` },
    { role: "user", content: "二面已结束,按系统要求只返回那个 JSON。" },
  ];

  try {
    const provider = getProvider(MODEL);
    const resp = await provider.generateResponse({
      messages,
      temperature: 0.3,
      maxTokens: 4000,
      model: MODEL,
    });
    const txt = resp.content || "";
    const s = txt.indexOf("{");
    const e = txt.lastIndexOf("}");
    if (s < 0 || e <= s) return NextResponse.json({ ...EMPTY, error: "AI 没返回有效结果,请重试" });
    const data = JSON.parse(txt.slice(s, e + 1));
    const rec = String(data.recommendation || "").trim();
    return NextResponse.json({
      recommendation: ["通过", "待定", "不通过"].includes(rec) ? rec : "待定",
      summary: String(data.summary || "").slice(0, 300),
      highlights: Array.isArray(data.highlights) ? data.highlights.map((x: unknown) => String(x)).slice(0, 4) : [],
      risks: Array.isArray(data.risks) ? data.risks.map((x: unknown) => String(x)).slice(0, 4) : [],
    });
  } catch (err) {
    log.warn("conclude failed:", String(err).slice(0, 200));
    return NextResponse.json({ ...EMPTY, error: "生成失败,稍后重试(可能 DeepSeek 限流)" });
  }
}
