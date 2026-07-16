import { extractJson } from "@/lib/ai/extract-json";
import { getProvider, REPORT_MODEL } from "@/lib/ai/registry";
import { createLogger } from "@/lib/logger";
import { NextResponse } from "next/server";
import * as fs from "fs";

export const runtime = "nodejs";
const log = createLogger("api/opc-score");

const WEIGHTS: Record<string, number> = {
  "技能": 0.70, "性格可靠度": 0.17, "培训认证": 0.08, "学历": 0.05,
};

const SYSTEM = `你是 OpRun 的资深能力评估官,用"结构化面试 + 行为锚定评分"给一位一人公司创业者(OPC)做多元化能力评测。这不是招聘录用,是给"接活派活"用的能力画像,禁止出现"录用/淘汰"。只输出 JSON,不要多余文字、不要 markdown 代码块。

【四大板块 + 权重】(总分按权重合成)
1. 技能(权重 0.70,大头):他真会什么、真做过什么。看专业知识深度、亲手操作的细节、真实交付证据,以及沟通/对客户/项目管理这些职业技能。
2. 性格可靠度(权重 0.17):只从他"怎么答"里判断靠不靠谱(尽责性)——有没有给具体数字、有没有质量自查机制、前后是否一致、是否不夸大、抗压和适应。不做心理测评,只看行为。接活没人监工,靠谱度决定敢不敢放心把活交给他。
3. 培训认证(权重 0.08):把他提到的培训/证书收下来,标"待认证"(平台以后再核真伪),现在只作成长信号、不给满分。
4. 学历(权重 0.05):把他提到的学历收下来,标"待认证",只加分、不当门槛。

【每个板块 1-5 分,严格按行为打分,不凭印象】
技能:5=讲得出原理+亲手做的步骤+数字+踩过的坑;3=做过但说不清细节;1=只堆名词、说不出亲手做了啥。
性格可靠度:5=有明确质量机制(抽检/自查/标准)+给得出数字+前后一致+不夸大;3=知道要认真但无机制;1=空泛/回避/前后矛盾/明显夸大。
培训认证:有可信培训或证书=按相关性给分(待认证);完全没提=3;一问就空=1。
学历:有明确学历=按相关性给分(待认证);没提=3。

【真假可靠度】真做过的人答得出具体做法/数字/取舍/失败/踩坑;夸大的人越追越空、给不出数字、把团队做的说成自己的、前后矛盾。

【等级评定】根据四板块总分和可靠度给一个"起步等级"(AI 面试定的是起点,不是终身):
- 新手:能接基础活(微活/小活)。总分<70,或关键板块弱,或可靠度存疑/明显夸大。
- 熟手:有扎实真本事,能接到中型项目。总分>=70 且 可靠度真实可信 且 技能板块>=4 分。
- "专家"不在面试里定——必须有真实交付战绩 + 平台人工面审才解锁(防止一次面试就刷上去),所以 AI 面试最高只给到"熟手"。
再给:能接哪些活、距下一级还差什么(具体可执行,例如"性格可靠度只 3 分:多讲质量自查机制和具体数字就能升")。

【知识校验】对话里若小君穿插了有标准答案的小知识题,把题、标准答案、OPC 的回答、对错记进"知识校验";答错或答不出 = 能力存疑的硬证据,要在可靠度和技能分里反映。没穿插就给空数组。

【认证凭证】若 OPC 主动提供了学信网在线验证报告的 12 位验证码、或职业资格/技能证书编号,收进"认证凭证"并标"待核验"(平台后续走学信网/人社部官方、本人授权核验);没提供就给空数组。

只输出如下 JSON(不要自己算总分,系统按权重算):
{
  "整体可靠度": "真实可信" | "存疑" | "明显夸大",
  "一句话结论": "<一句话>",
  "等级评定": { "起步等级": "新手|熟手", "理由": "<为什么这个等级>", "能接的活": "<能接哪些活>", "距下一级还差": ["<具体可执行的差距>"] },
  "板块评分": [
    { "板块": "技能", "分": 3, "依据": "<钉到他哪句话>" },
    { "板块": "性格可靠度", "分": 3, "依据": "..." },
    { "板块": "培训认证", "分": 3, "依据": "...", "状态": "待认证" },
    { "板块": "学历", "分": 3, "依据": "...", "状态": "待认证" }
  ],
  "技能画像": [ { "技能": "<细技能点>", "领域": "<哪个领域>", "水平": "初级|中级|高级", "分": 70, "证据": "<例子或数字>", "可靠度": "真实可信|存疑|明显夸大" } ],
  "性格可靠度画像": { "靠谱度": "高|中|低", "依据": "<从哪些行为判断的>" },
  "得分点": ["..."],
  "丢分点": ["..."],
  "认证凭证": [ { "类型": "学历|职业证书", "凭证号": "<学信网12位验证码或证书编号>", "状态": "待核验" } ],
  "知识校验": [ { "题": "<穿插的标准答案小题>", "标准答案": "<对的答案>", "他的回答": "<OPC怎么答的>", "对错": "对|错|没问" } ],
  "可靠度依据": "<为什么判这个可靠度,具体哪几句>"
}`;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const transcript = body?.transcript;
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return NextResponse.json({ error: "no transcript" }, { status: 400 });
    }
    const convo = transcript.map((m: { role: string; content: string }) => (m.role === "user" ? "OPC：" : "面试官：") + m.content).join("\n");
    const provider = getProvider(REPORT_MODEL);
    const response = await provider.generateResponse({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "这是完整对话(多元化评测，OPC 可能跨多个领域)。请按四大板块打分，尽量多地抽出具体细技能点(每条带 0-100 分)，输出 JSON：\n\n" + convo },
      ],
      temperature: 0.2,
      maxTokens: 4096,
      model: REPORT_MODEL,
    });
    let report: any;
    try { report = extractJson(response.content); } catch { return NextResponse.json({ error: "parse-failed", raw: response.content.slice(0, 400) }, { status: 500 }); }
    try {
      let total = 0, wsum = 0;
      for (const d of (report["板块评分"] || [])) {
        const w = WEIGHTS[d["板块"]] || 0;
        const s = Math.max(1, Math.min(5, Number(d["分"]) || 3));
        total += (s / 5) * w; wsum += w;
      }
      report["总分"] = wsum > 0 ? Math.round((total / wsum) * 100) : null;
    } catch { report["总分"] = null; }
    try {
      fs.mkdirSync("/root/aural-oss/opc-reports", { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync("/root/aural-oss/opc-reports/report-" + ts + ".json", JSON.stringify({ transcript, report }, null, 2));
    } catch { log.warn("save failed"); }
    return NextResponse.json({ report });
  } catch (err) {
    log.error("opc-score error", err);
    return NextResponse.json({ error: String(err).slice(0, 200) }, { status: 500 });
  }
}
