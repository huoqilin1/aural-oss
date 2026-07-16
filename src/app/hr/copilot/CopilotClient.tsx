"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useRelayAsrInput } from "@/hooks/use-relay-asr-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

type Term = { term: string; plain: string };
type Suspicion = { point: string; suggest: string; evidence?: string };
type QStatus = "active" | "done" | "closed"; // 进行中 / 已完成(AI判) / 手动关
type Q = { id: string; text: string; status: QStatus; kind: "岗位" | "简历" | "hr"; round1?: boolean };
type Concl = { recommendation: string; summary: string; highlights: string[]; risks: string[] };

const HBAR = "h-1.5 bg-border transition-colors hover:bg-primary/60 data-[resize-handle-state=drag]:bg-primary";
const VBAR = "w-1.5 bg-border transition-colors hover:bg-primary/60 data-[resize-handle-state=drag]:bg-primary";

export default function HrCopilotPage() {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [terms, setTerms] = useState<Term[]>([]);
  const [cards, setCards] = useState<Suspicion[]>([]);
  const [questions, setQuestions] = useState<Q[]>([]);
  const [newQ, setNewQ] = useState("");
  const [meta, setMeta] = useState<{ name: string; position: string }>({ name: "候选人", position: "" });
  const [oneRound, setOneRound] = useState("");
  const [saved, setSaved] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [contextStatus, setContextStatus] = useState<"loading" | "ready" | "error">("loading");
  const [contextError, setContextError] = useState("");
  const [round1Count, setRound1Count] = useState<number | null>(null); // 一面题数:null=未加载,0=该候选人没真做过一面
  const [proctoring, setProctoring] = useState<{ cheat_risk?: string; evidence?: string } | null>(null); // 一面作弊标记,顶部常驻
  const [dialog, setDialog] = useState<{ role: string; text: string }[]>([]); // 一面问答记录
  const [showDialog, setShowDialog] = useState(false);
  const [show, setShow] = useState<Record<QStatus, boolean>>({ active: true, done: false, closed: false });
  // 二面结果(AI 草稿 → HR 可改 → 存进候选人档案)
  const [genBusy, setGenBusy] = useState(false);
  const [showConcl, setShowConcl] = useState(false);
  const [editRec, setEditRec] = useState("待定");
  const [editText, setEditText] = useState("");

  const transcriptRef = useRef("");
  const lastLenRef = useRef(0);
  const busyRef = useRef(false);
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const resumeRef = useRef("");
  const oneRoundRef = useRef("");
  const cidRef = useRef<string | null>(null);
  const sessionIdRef = useRef("");
  const revisionRef = useRef(0);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cardsEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const cid = p.get("cid");
    cidRef.current = cid;
    if (!cid) { const name = p.get("name"); if (name) setMeta((m) => ({ ...m, name })); setContextStatus("ready"); return; }
    fetch(`/api/hr-copilot/context?cid=${encodeURIComponent(cid)}`).then((r) => r.json()).then((d) => {
      if (!d || d.success === false) { setContextStatus("error"); setContextError(d?.error || "候选人资料加载失败"); return; }
      if (d.name) setMeta((m) => ({ ...m, name: d.name }));
      if (typeof d.position === "string") setMeta((m) => ({ ...m, position: d.position }));
      if (typeof d.resume_text === "string") resumeRef.current = d.resume_text;
      if (typeof d.one_round_summary === "string") { setOneRound(d.one_round_summary); oneRoundRef.current = d.one_round_summary; }
      // 右栏清单 = 一面真题(简历题/岗位题,全标"一面已问")。没一面数据则空。
      if (Array.isArray(d.checklist)) {
        setQuestions(d.checklist.map((q: any, i: number) => ({
          id: `r1-${i}`,
          text: String(q.text || ""),
          status: "active" as QStatus,
          kind: (q.kind === "岗位" ? "岗位" : "简历") as "岗位" | "简历",
          round1: true,
        })).filter((q: Q) => q.text));
      }
      if (typeof d.one_round_has_questions === "number") setRound1Count(d.one_round_has_questions);
      else if (Array.isArray(d.checklist)) setRound1Count(d.checklist.length);
      if (Array.isArray(d.one_round_dialog)) setDialog(d.one_round_dialog);
      if (d.proctoring && d.proctoring.cheat_risk) setProctoring(d.proctoring);
      setContextError("");
      setContextStatus("ready");
      if (d.draft && typeof d.draft.transcript === "string" && !transcriptRef.current) {
        const restored = d.draft.transcript;
        transcriptRef.current = restored;
        setTranscript(restored);
        lastLenRef.current = restored.length;
        sessionIdRef.current = String(d.draft.session_id || "");
        revisionRef.current = Number(d.draft.revision || 0);
        if (restored) setSaved("Recovered autosaved transcript");
      }
    }).catch(() => { setContextStatus("error"); setContextError("候选人资料加载失败，可先录音，稍后刷新重试"); });
  }, []);

  const persistDraft = useCallback(async (text = transcriptRef.current) => {
    const cid = cidRef.current;
    if (!cid) return false;
    if (!sessionIdRef.current) {
      sessionIdRef.current = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now().toString(16).slice(-8).padStart(8, "0")}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
    }
    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    const response = await fetch(`/api/hr-copilot/context?cid=${encodeURIComponent(cid)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        session_id: sessionIdRef.current,
        revision,
        transcript: text,
      }),
    });
    return response.ok;
  }, []);

  const scheduleDraft = useCallback((full: string) => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void persistDraft(full).catch(() => undefined);
    }, 1200);
  }, [persistDraft]);

  const onTranscript = useCallback((full: string) => {
    transcriptRef.current = full;
    setTranscript(full);
    scheduleDraft(full);
  }, [scheduleDraft]);
  const relay = useRelayAsrInput({ language: "zh", onTranscript });

  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(async () => {
      if (busyRef.current) return;
      const full = transcriptRef.current;
      if (full.length <= lastLenRef.current + 6) return;
      const segment = full.slice(lastLenRef.current).trim();
      if (!segment) return;
      busyRef.current = true;
      try {
        const r = await fetch("/api/hr-copilot/analyze", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segment, position: metaRef.current.position || "通用岗位", resume: resumeRef.current, oneRoundSummary: oneRoundRef.current, checklist: questionsRef.current.map((q) => q.text) }),
        });
        const d = await r.json();
        if (!r.ok || d.success === false) throw new Error(d.error || "ANALYZE_FAILED");
        setAnalysisError("");
        if (Array.isArray(d.terms) && d.terms.length) setTerms((prev) => [...prev, ...d.terms].slice(-30));
        if (Array.isArray(d.suspicions) && d.suspicions.length) setCards((prev) => [...prev, ...d.suspicions].slice(-40));
        // 候选人答到某清单题 → 自动撤下、标"已完成"(只动进行中的)
        if (Array.isArray(d.hits) && d.hits.length) setQuestions((prev) => prev.map((q, i) => (d.hits.includes(i + 1) && q.status === "active" ? { ...q, status: "done" as QStatus } : q)));
        lastLenRef.current = full.length;
      } catch (error) {
        setAnalysisError("\u5b9e\u65f6\u5206\u6790\u6682\u65f6\u5931\u8d25\uff0c\u8fd9\u6bb5\u5bf9\u8bdd\u5df2\u4fdd\u7559\uff0c\u7cfb\u7edf\u4f1a\u81ea\u52a8\u91cd\u8bd5\u3002");
        console.error("hr-copilot analyze failed", error);
      } finally {
        busyRef.current = false;
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [listening]);

  useEffect(() => {
    const flush = () => { void persistDraft().catch(() => undefined); };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      flush();
    };
  }, [persistDraft]);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [transcript]);
  useEffect(() => { cardsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [cards]);

  const start = () => {
    setListening(true);
    try { void relay.start(transcriptRef.current); } catch { /* */ }
  };
  const stop = () => {
    setListening(false);
    try { relay.stop(); } catch { /* */ }
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    void persistDraft().catch(() => undefined);
  };
  const addQuestion = () => { const t = newQ.trim(); if (!t) return; setQuestions((prev) => [...prev, { id: `hr-${Date.now()}`, text: t, status: "active", kind: "hr" }]); setNewQ(""); };
  const setStatus = (id: string, status: QStatus) => setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, status } : q)));
  const toggleShow = (k: QStatus) => setShow((s) => ({ ...s, [k]: !s[k] }));

  const fmtConcl = (c: Concl) =>
    `总评:${c.summary || "—"}\n\n亮点:\n${(c.highlights || []).map((h) => "· " + h).join("\n") || "· —"}\n\n存疑/风险:\n${(c.risks || []).map((r) => "· " + r).join("\n") || "· (无)"}`;

  // 面完点一次:AI 出二面结果草稿 → 打开弹窗给 HR 改
  const genConclusion = async () => {
    if (genBusy) return;
    const t = transcriptRef.current || "";
    if (t.trim().length < 10) { setSaved("二面还没录到内容,先点开始录音"); return; }
    setGenBusy(true); setSaved("AI 生成二面结果中(深度线,约 10–20 秒)…");
    try {
      const r = await fetch("/api/hr-copilot/conclude", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: t, position: metaRef.current.position || "通用岗位", resume: resumeRef.current, oneRoundSummary: oneRoundRef.current, checklist: questionsRef.current.map((q) => q.text), done: questions.filter((q) => q.status === "done").length }),
      });
      const d = await r.json();
      if (d.error) { setSaved(d.error); setGenBusy(false); return; }
      const c: Concl = { recommendation: d.recommendation || "待定", summary: d.summary || "", highlights: d.highlights || [], risks: d.risks || [] };
      setEditRec(c.recommendation); setEditText(fmtConcl(c)); setShowConcl(true); setSaved("");
    } catch (e) { setSaved("生成失败:" + String(e).slice(0, 60)); }
    setGenBusy(false);
  };

  // HR 改完 → 存进候选人档案(OpRun interview_history round=2),候选人面板可回看
  const saveConclusion = async () => {
    const cid = cidRef.current;
    if (!cid) { setSaved("无候选人 id"); return; }
    setSaved("存储中…");
    await persistDraft();
    try {
      const r = await fetch(`/api/hr-copilot/context?cid=${encodeURIComponent(cid)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionIdRef.current, transcript: transcriptRef.current, hr_note: `岗位:${metaRef.current.position}|已答题 ${questions.filter((q) => q.status === "done").length}`, recommendation: editRec, ai_summary: editText }) });
      const d = await r.json();
      if (d.success) { setSaved(`已存入候选人档案(round ${d.interview_round})`); setShowConcl(false); }
      else setSaved(`存储失败:${d.error || ""}`);
    } catch (e) { setSaved("存储失败:" + String(e).slice(0, 60)); }
  };
  const kindTag = (k: Q["kind"], round1?: boolean) => (k === "hr" ? "HR加" : k === "岗位" ? (round1 ? "一面·岗位" : "岗位") : (round1 ? "一面·简历" : "简历"));

  const cnt = { active: questions.filter((q) => q.status === "active").length, done: questions.filter((q) => q.status === "done").length, closed: questions.filter((q) => q.status === "closed").length };
  const visible = questions.filter((q) => show[q.status]);
  const chip = (k: QStatus, label: string, n: number) => (
    <button onClick={() => toggleShow(k)} className={`rounded-full px-2.5 py-1 text-xs transition-colors ${show[k] ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:border-primary/50"}`}>{label} {n}</button>
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <div className="flex items-center gap-3">
          <span className="font-heading text-base font-bold tracking-[2px] text-primary">数君</span>
          <span className="text-sm text-muted-foreground">二面 · HR 陪面台(AI 军师)</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">候选人 <b className="text-foreground">{contextStatus === "loading" ? "资料加载中…" : meta.name}</b></span>
          {meta.position && <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">应聘 {meta.position}</span>}
          {saved && <span className="text-xs text-primary">{saved}</span>}
          <button onClick={genConclusion} disabled={genBusy} className="rounded-full bg-primary/90 px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary disabled:opacity-50">{genBusy ? "生成中…" : "生成二面结果"}</button>
          {listening
            ? <button onClick={stop} className="rounded-full bg-destructive/15 px-4 py-1.5 text-sm font-medium text-destructive">■ 停止录音</button>
            : <button onClick={start} className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground">● 开始录音</button>}
        </div>
      </header>
      {contextStatus === "loading" && (
        <div className="shrink-0 border-b border-primary/30 bg-primary/5 px-5 py-2 text-xs text-muted-foreground">
          候选人资料加载中，录音可以先开始；资料到达后会自动补全岗位、一面结论和问题清单。
        </div>
      )}
      {contextStatus === "error" && (
        <div className="flex shrink-0 items-center justify-between border-b border-amber-400/40 bg-amber-400/10 px-5 py-2 text-xs text-amber-200">
          <span>{contextError || "候选人资料加载失败"}，录音仍可正常使用。</span>
          <button onClick={() => window.location.reload()} className="rounded border border-amber-300/50 px-2 py-0.5 hover:bg-amber-300/10">刷新重试</button>
        </div>
      )}

      {proctoring && proctoring.cheat_risk && proctoring.cheat_risk !== "low" && (
        <div className={`shrink-0 border-b px-5 py-2 text-xs font-medium ${proctoring.cheat_risk === "high" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-amber-400/40 bg-amber-400/10 text-amber-200"}`}>
          ⚠ 一面作弊疑点:{proctoring.cheat_risk === "high" ? "高" : "中"}{proctoring.evidence && proctoring.evidence !== "无" ? ` · ${proctoring.evidence}` : ""} —— 二面留意当面核验
        </div>
      )}
      <div className="shrink-0 border-b border-border bg-muted/30 px-5 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate"><span className="mr-2 font-medium text-foreground/70">一面结论:</span>{oneRound || "(该候选人暂无一面结论)"}</span>
          {dialog.length > 0 && (
            <button onClick={() => setShowDialog((v) => !v)} className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] hover:border-primary/50">
              {showDialog ? "收起一面问答 ▲" : `看一面问答(${dialog.length})▼`}
            </button>
          )}
        </div>
        {showDialog && (
          <div className="mt-2 max-h-52 overflow-y-auto rounded-md border border-border bg-background p-2">
            {dialog.map((m, i) => (
              <div key={i} className="mb-1.5 text-xs leading-relaxed">
                <span className={`mr-1 rounded px-1.5 py-0.5 text-[10px] ${m.role === "候选人" ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>{m.role}</span>
                <span className="text-foreground/90">{m.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {analysisError && (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-5 py-2 text-xs text-destructive">
          {analysisError}
        </div>
      )}
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize={62} minSize={30} className="flex min-h-0 flex-col">
          <PanelGroup direction="vertical" className="min-h-0 flex-1">
            <Panel defaultSize={38} minSize={8} className="flex min-h-0 flex-col">
              <div className="shrink-0 px-5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">实时转写</div>
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-1 text-sm leading-relaxed">
                {transcript ? <p className="whitespace-pre-wrap text-foreground/90">{transcript}</p> : <p className="text-muted-foreground">点右上「开始录音」,对话实时转文字。</p>}
              </div>
            </Panel>
            <PanelResizeHandle className={HBAR} />
            <Panel defaultSize={24} minSize={8} className="flex min-h-0 flex-col">
              <div className="shrink-0 px-5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">行话翻译(给你听懂)</div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">
                {terms.length === 0 && <p className="text-sm text-muted-foreground">候选人讲到专业词,这里翻成大白话。</p>}
                <div className="flex flex-col gap-1">{terms.map((t, i) => <div key={i} className="text-sm"><span className="rounded bg-amber-300/80 px-1.5 py-0.5 font-medium text-black">{t.term}</span><span className="ml-2 text-muted-foreground">{t.plain}</span></div>)}</div>
              </div>
            </Panel>
            <PanelResizeHandle className={HBAR} />
            <Panel defaultSize={38} minSize={8} className="flex min-h-0 flex-col">
              <div className="shrink-0 px-5 pt-2 text-xs font-medium uppercase tracking-wide text-primary">⚠ AI 临时追问(顺着他刚说的,问不完没关系)</div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">
                {cards.length === 0 && <p className="text-sm text-muted-foreground">候选人讲到存疑、和简历对不上、太空泛处,这里实时蹦追问。</p>}
                <div className="flex flex-col gap-2">
                  {cards.map((c, i) => <div key={i} className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"><div className="text-foreground">↳ {c.suggest}</div><div className="mt-1 text-xs text-muted-foreground">存疑:{c.point}</div>{c.evidence && <div className="mt-1 text-xs text-amber-300/90">依据:{c.evidence}</div>}</div>)}
                  <div ref={cardsEndRef} />
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className={VBAR} />

        <Panel defaultSize={38} minSize={20} className="flex min-h-0 flex-col bg-card">
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="mb-2 text-sm font-semibold">一面题清单(HR 照着深挖)</div>
            <div className="flex flex-wrap gap-1.5">
              {chip("active", "进行中", cnt.active)}
              {chip("done", "已完成·AI", cnt.done)}
              {chip("closed", "手动关", cnt.closed)}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {round1Count === 0 && (
              <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                该候选人还没真做过一面(没有一面题可调)。可在招聘后台先发起一面,或下方临时加题。
              </div>
            )}
            {visible.length === 0 && round1Count !== 0 && <p className="text-sm text-muted-foreground">答过的/关掉的会自动撤下,点上面标签可调出来看。</p>}
            <div className="flex flex-col gap-2">
              {visible.map((q) => {
                const isActive = q.status === "active";
                return (
                  <div key={q.id} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${isActive ? "border-border bg-background" : "border-border bg-muted/40 text-muted-foreground"}`}>
                    <div className="min-w-0 flex-1">
                      <span className={isActive ? "text-foreground" : "line-through"}>{q.text}</span>
                      <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${q.kind === "岗位" ? "bg-primary/20 text-primary" : q.kind === "简历" ? "bg-secondary/20 text-secondary-foreground" : "bg-muted text-muted-foreground"}`}>{kindTag(q.kind, q.round1)}</span>
                      {q.status === "done" && <span className="ml-1 rounded bg-secondary/20 px-1.5 py-0.5 text-[10px] text-secondary-foreground">已完成</span>}
                      {q.status === "closed" && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px]">手动关</span>}
                    </div>
                    {isActive
                      ? <button onClick={() => setStatus(q.id, "closed")} title="撤下" className="shrink-0 rounded px-1.5 text-base leading-none text-muted-foreground hover:text-destructive">×</button>
                      : <button onClick={() => setStatus(q.id, "active")} title="调回进行中" className="shrink-0 rounded px-1.5 text-xs text-muted-foreground hover:text-primary">↩</button>}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="shrink-0 border-t border-border p-3">
            <div className="flex gap-2">
              <input value={newQ} onChange={(e) => setNewQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addQuestion()} placeholder="+ 面试官临时加一个问题…" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
              <button onClick={addQuestion} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">追加</button>
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {showConcl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowConcl(false)}>
          <div className="max-h-[86vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">二面结果 · 候选人 {meta.name}</h3>
              <button onClick={() => setShowConcl(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">AI 军师按二面全程出的草稿,你可改后再存;最终由你拍板。</p>
            <div className="mb-3">
              <label className="mb-1 block text-xs text-muted-foreground">推荐档(你拍板)</label>
              <div className="flex gap-2">
                {["通过", "待定", "不通过"].map((r) => (
                  <button key={r} onClick={() => setEditRec(r)} className={`rounded-full px-4 py-1.5 text-sm ${editRec === r ? (r === "不通过" ? "bg-destructive text-white" : "bg-primary text-primary-foreground") : "border border-border text-muted-foreground hover:border-primary/50"}`}>{r}</button>
                ))}
              </div>
            </div>
            <div className="mb-4">
              <label className="mb-1 block text-xs text-muted-foreground">总评 · 亮点 · 风险(可改)</label>
              <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={13} className="w-full rounded-md border border-border bg-background p-3 text-sm leading-relaxed outline-none focus:border-primary/60" />
            </div>
            <div className="flex items-center justify-end gap-2">
              {saved && <span className="mr-auto text-xs text-primary">{saved}</span>}
              <button onClick={() => setShowConcl(false)} className="rounded-full border border-border px-4 py-1.5 text-sm">取消</button>
              <button onClick={saveConclusion} className="rounded-full bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground">存入候选人档案</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
