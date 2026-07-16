"use client";
import { useVoice } from "@/hooks/use-voice";
import { useState } from "react";

const navy = "#0F1B2D", gold = "#D6B98A";
const relColor = (r: string) => (r === "真实可信" || r === "高" ? "#22C55E" : r === "明显夸大" || r === "低" ? "#EF4444" : "#E5D2A8");

const AMMO = `【多元评测·考官弹药库】OPC 可能同时会好几个领域。从他的回答里识别出所有涉及的领域,每个都按下面对应考点深挖,抓一条条具体的细技能点(不是"会数据标注"这种大类,是"会排查标注一致性"这种小点)。听到新领域就接着挖,别漏。同时留意他靠不靠谱(有没有数字、有没有质量自查、前后一致、不夸大)、提到的学历和培训证书。
1 AI训练/数据标注:训练范式(RLHF/SFT/DPO)区别、标注一致性排查、欠拟合vs过拟合、枯燥标注保质、规范临时切换处理已标部分
2 具身智能:遥操作/示教/仿真采集优缺点、SLAM标注失败模式、示教轨迹可复现、采速vs质量沟通、场景切换调整
3 数据要素/合规:数据入表+合规、脱敏/匿名化/差分隐私取舍、数据治理经历、上交易所先核啥、客户施压跳合规
4 内容创意:SEO要素、短视频黄金3秒、品牌文案或代运营、烂素材怎么救、客户反复改稿管预期
5 软件开发:SaaS/小程序/API差异、技术栈选型、完整后端服务经历、生产bug排查顺序、不合理需求劝退
6 专业服务(法/财/IP):合同审查风险点、财税坑、咨询经历、出意见排优先级、术语解释
7 低空/无人机:航拍/倾斜摄影/测绘差异、飞行前空域合规、巡线/巡检/测绘经历、应急、任务量权衡
软技能(都问):模糊需求怎么问清范围;同时多单怎么排优先级。
出题方式:STAR行为题(讲一次具体经历:当时情况、你的任务、你具体做了什么、结果怎样),顺着实时追问到细节(具体数字、真踩的坑),含糊就再追一层戳穿夸大。
评测中穿插 1-2 道该领域有标准答案的小知识题(例如标注赛道问"标注一致性常用什么指标"、开发赛道问"HTTP 429 状态码什么意思"),记录他答对没,作为能力的客观交叉验证(光会吹、答不出标准题=存疑)。
另外主动问一句(选填、不强制):有没有学历或职业证书?有的话请报学信网在线验证报告的 12 位验证码、或职业资格证书编号,方便平台核真伪;没有也完全不影响接活。`;

const CTX = {
  title: "OpRun 能力评估",
  objective: "多元化能力评测:把这位一人公司创业者(OPC)所有的技能问透、验真。识别他涉及的每一个领域,各自抓出一条条具体的细技能点 + 水平 + 真假可靠度;同时留意他的靠谱度、学历、培训证书。别漏任何一摊。",
  aiName: "小君", aiTone: "Professional", language: "zh", followUpDepth: "DEEP",
  questions: [{ text: "先把你所有的技能、做过的活都讲一讲——你会什么、做过哪些项目、最拿手的是什么。这是一个多元化评测,讲得越全越好;我会顺着你讲的,一个一个领域深入追问。", type: "OPEN_ENDED", description: AMMO, order: 0 }],
};

function ReportView({ report }: { report: any }) {
  if (!report) return null;
  if (report.error) return <div style={{ color: "#EF4444", maxWidth: 660 }}>报告生成失败:{report.error}</div>;
  const bk = Array.isArray(report["板块评分"]) ? report["板块评分"] : [];
  const sk = Array.isArray(report["技能画像"]) ? report["技能画像"] : [];
  const pc = report["性格可靠度画像"];
  return (
    <div style={{ width: "100%", maxWidth: 660, background: "rgba(255,255,255,0.06)", border: "1px solid " + gold, borderRadius: 12, padding: 18, marginTop: 6, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: gold, fontSize: 18, fontWeight: 700 }}>测评报告</div>
      <div style={{ fontSize: 16 }}>总分:<b style={{ color: gold }}>{report["总分"]}</b> / 100 ｜ 可靠度:<b style={{ color: relColor(report["整体可靠度"]) }}>{report["整体可靠度"]}</b></div>
      <div style={{ fontSize: 15, color: "#cdd7e1" }}>{report["一句话结论"]}</div>
      {report["等级评定"] ? (<div style={{ background: "rgba(214,185,138,0.12)", border: "1px solid " + gold, borderRadius: 10, padding: 12, fontSize: 14 }}><div>起步等级:<b style={{ color: gold, fontSize: 16 }}>{report["等级评定"]["起步等级"]}</b> ｜ 能接:{report["等级评定"]["能接的活"]}</div><div style={{ color: "#cdd7e1", marginTop: 4 }}>{report["等级评定"]["理由"]}</div>{Array.isArray(report["等级评定"]["距下一级还差"]) ? <div style={{ color: "#E5D2A8", marginTop: 4 }}>距下一级还差:{report["等级评定"]["距下一级还差"].join("；")}</div> : null}</div>) : null}
      <div><div style={{ color: gold, fontSize: 14, marginBottom: 4 }}>四大板块</div>{bk.map((d: any, i: number) => (<div key={i} style={{ fontSize: 14, marginBottom: 2 }}>{d["板块"]}:<b>{d["分"]}</b>/5 {d["状态"] ? <span style={{ color: "#E5D2A8" }}>({d["状态"]})</span> : null} —— <span style={{ color: "#8aa0b8" }}>{d["依据"]}</span></div>))}</div>
      <div><div style={{ color: gold, fontSize: 14, marginBottom: 4 }}>能力画像(每条带分)</div>{sk.map((s: any, i: number) => (<div key={i} style={{ fontSize: 14, marginBottom: 3 }}>{s["领域"] ? <span style={{ color: "#E5D2A8" }}>[{s["领域"]}] </span> : null}<b>{s["技能"]}</b> <span style={{ color: gold }}>{s["分"]}分</span> · {s["水平"]} · <span style={{ color: relColor(s["可靠度"]) }}>{s["可靠度"]}</span> —— <span style={{ color: "#8aa0b8" }}>{s["证据"]}</span></div>))}</div>
      {pc ? <div style={{ fontSize: 14 }}>性格靠谱度:<b style={{ color: relColor(pc["靠谱度"]) }}>{pc["靠谱度"]}</b> —— <span style={{ color: "#8aa0b8" }}>{pc["依据"]}</span></div> : null}
      {Array.isArray(report["得分点"]) && <div style={{ fontSize: 14 }}><span style={{ color: "#22C55E" }}>得分点:</span>{report["得分点"].join("；")}</div>}
      {Array.isArray(report["丢分点"]) && <div style={{ fontSize: 14 }}><span style={{ color: "#EF4444" }}>丢分点:</span>{report["丢分点"].join("；")}</div>}
      {Array.isArray(report["认证凭证"]) && report["认证凭证"].length > 0 ? (<div><div style={{ color: gold, fontSize: 14, marginBottom: 4 }}>认证凭证(本人授权 · 待核验)</div>{report["认证凭证"].map((c: any, i: number) => (<div key={i} style={{ fontSize: 14, marginBottom: 2 }}>{c["类型"]}:{c["凭证号"]} · <span style={{ color: "#E5D2A8" }}>{c["状态"]}</span> · <a href={String(c["类型"]).indexOf("学历") >= 0 ? "https://www.chsi.com.cn/xlcx/" : "http://zscx.osta.org.cn/"} target="_blank" rel="noreferrer" style={{ color: gold }}>去官方核验</a></div>))}<div style={{ fontSize: 12, color: "#8aa0b8", marginTop: 2 }}>核验走学信网 / 人社部官方页、本人授权;接 OpRun 实名体系后自动登记核验状态。</div></div>) : null}
      {report["可靠度依据"] && <div style={{ fontSize: 13, color: "#8aa0b8" }}>真假判断依据:{report["可靠度依据"]}</div>}
    </div>
  );
}

export default function Page() {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [report, setReport] = useState<any>(null);
  const [scoring, setScoring] = useState(false);
  const [text, setText] = useState("");
  const v = useVoice({
    interviewId: "opc", sessionId: "opc", interviewContext: CTX,
    onTranscript: (t: string, isFinal: boolean) => { if (isFinal && t && t.trim()) setMessages((p) => [...p, { role: "user", content: t.trim() }]); },
    onAIResponse: (t: string) => { if (t && t.trim()) setMessages((p) => [...p, { role: "assistant", content: t.trim() }]); },
  });
  const status = !v.isConnected ? "未开始" : v.isSpeaking ? "小君在说话…" : v.isProcessing ? "小君在思考…" : v.isListening ? "在听你说…" : "已连接";
  const send = () => { const t = text.trim(); if (t && v.isConnected) { setMessages((p) => [...p, { role: "user", content: t }]); v.sendTextMessage(t); setText(""); } };
  const finish = async () => {
    setScoring(true);
    try { await v.disconnect(); } catch (e) {}
    try {
      const res = await fetch("/api/opc-score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: messages }) });
      const data = await res.json();
      setReport(data.report || { error: data.error || "无返回" });
    } catch (e) { setReport({ error: String(e) }); }
    setScoring(false);
  };
  return (
    <div style={{ minHeight: "100vh", background: navy, color: "#fff", fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 20px", gap: 16 }}>
      <div style={{ color: gold, fontSize: 22, fontWeight: 700 }}>OpRun 能力评估 · 小君</div>
      <div style={{ color: "#cdd7e1", fontSize: 14, maxWidth: 640, textAlign: "center" }}>多元化评测——把你会的所有技能、做过的活都讲出来,讲得越全越好,小君会顺着你说的一个一个深入追问。中途想补充随时打字。</div>
      <div style={{ maxWidth: 660, background: "rgba(255,255,255,0.06)", border: "1px solid " + gold, borderRadius: 12, padding: 20, fontSize: 17, lineHeight: 1.7 }}>{CTX.questions[0].text}</div>
      {!v.isConnected ? (
        <button onClick={() => { setMessages([]); setReport(null); v.connect(); }} style={{ background: gold, color: navy, border: "none", borderRadius: 999, padding: "14px 36px", fontSize: 18, fontWeight: 700, cursor: "pointer" }}>开始面试(允许麦克风;没麦也能进)</button>
      ) : (
        <button onClick={finish} disabled={scoring} style={{ background: "#EF4444", color: "#fff", border: "none", borderRadius: 999, padding: "14px 36px", fontSize: 18, fontWeight: 700, cursor: "pointer" }}>{scoring ? "生成报告中…" : "结束面试并出测评报告"}</button>
      )}
      <div style={{ color: "#E5D2A8", fontSize: 15 }}>状态:{status}</div>
      <div style={{ width: "100%", maxWidth: 660, background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 14, maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && !v.userTranscript && !v.aiTranscript ? <div style={{ color: "#8aa0b8", fontSize: 14 }}>开始后,你和小君的完整对话会显示在这里。</div> : null}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.role === "user" ? "rgba(214,185,138,0.18)" : "rgba(255,255,255,0.07)", border: m.role === "user" ? "1px solid " + gold : "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "8px 12px", fontSize: 15, lineHeight: 1.5 }}>
            <div style={{ fontSize: 11, color: m.role === "user" ? gold : "#8aa0b8", marginBottom: 2 }}>{m.role === "user" ? "你" : "小君"}</div>{m.content}
          </div>
        ))}
        {v.userTranscript ? <div style={{ alignSelf: "flex-end", maxWidth: "85%", opacity: 0.6, fontSize: 15, color: "#cdd7e1" }}>你(说着):{v.userTranscript}</div> : null}
        {v.aiTranscript ? <div style={{ alignSelf: "flex-start", maxWidth: "85%", opacity: 0.6, fontSize: 15, color: gold }}>小君(说着):{v.aiTranscript}</div> : null}
      </div>
      {v.isConnected && (
        <div style={{ width: "100%", maxWidth: 660, display: "flex", gap: 8, alignItems: "center" }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} placeholder="没麦克风、或想补充?在这儿打字,回车或点发送…" style={{ flex: 1, background: "rgba(255,255,255,0.08)", border: "1px solid " + gold, borderRadius: 10, padding: "12px 14px", color: "#fff", fontSize: 16, outline: "none" }} />
          <button onClick={send} style={{ background: gold, color: navy, border: "none", borderRadius: 10, padding: "12px 22px", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>发送</button>
        </div>
      )}
      {scoring && <div style={{ color: gold }}>正在生成测评报告…</div>}
      <ReportView report={report} />
    </div>
  );
}
