/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

// 不缓存:每次都拉最新(否则候选人/题目改了取到旧的)
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// 陪面台进场:Aural 服务端用运营账号登录 OpRun 拿 token,再拉该候选人简历+一面结论+一面问过的题。
// 运营凭据走环境变量,缺省用演示运营账号(数君自招内部工具)。
const OPRUN = process.env.OPRUN_API_BASE || "https://www.agi.yifx.vip";
const OP_ID = process.env.OPRUN_OPERATOR_ID || "OP01";
const OP_PASS = process.env.OPRUN_OPERATOR_PASS || "123456";

type Q = { text: string; round1: boolean; kind: "简历" | "岗位" };

// 二面接通一面:按 aural_interview_id 调这场一面已生成的题。
// 一面出题结构(见 v1/generate-questions):order 升序 = [自我介绍, 4道简历题, 4道岗位题]。
// 二面不重复一面的自我介绍,把简历题/岗位题按位置切出来、全标"一面已问"给 HR 照着深挖。
async function pullOneRoundQuestions(interviewId: string): Promise<Q[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("questions")
      .select("order,text")
      .eq("interviewId", interviewId)
      .order("order", { ascending: true });
    if (error || !Array.isArray(data) || !data.length) return [];
    const out: Q[] = [];
    let idx = 0;
    for (const row of data) {
      const text = String((row as { text?: unknown }).text || "").trim();
      if (!text) {
        idx++;
        continue;
      }
      // 第一道(开场自我介绍)二面不再问,跳过
      if (idx === 0 && /自我介绍|介绍一下(自己|你自己)|介绍一下你/.test(text)) {
        idx++;
        continue;
      }
      // 跳过 intro 后:接着的 4 道是简历题,再后面是岗位题
      const kind: "简历" | "岗位" = idx <= 4 ? "简历" : "岗位";
      out.push({ text, round1: true, kind });
      idx++;
    }
    return out;
  } catch {
    return [];
  }
}

// 拉一面问答记录(小君问 + 候选人答),让 HR 点进来能看候选人一面具体答了啥(不只是题)
async function pullOneRoundDialog(interviewId: string): Promise<{ role: string; text: string }[]> {
  try {
    const { data: ses } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .eq("interviewId", interviewId)
      .order("createdAt", { ascending: false })
      .limit(1);
    if (!ses || !ses.length) return [];
    const sid = (ses[0] as { id: string }).id;
    const { data: msgs } = await supabaseAdmin
      .from("messages")
      .select("role,content")
      .eq("sessionId", sid)
      .order("id", { ascending: true });
    if (!Array.isArray(msgs)) return [];
    return msgs
      .map((m: any) => ({ role: String(m.role).toUpperCase() === "USER" ? "候选人" : "小君", text: String(m.content || "").trim() }))
      .filter((m) => m.text);
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const cid = new URL(req.url).searchParams.get("cid");
  if (!cid) return NextResponse.json({ success: false, error: "缺少 cid" }, { status: 400 });
  try {
    const lr = await fetch(`${OPRUN}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: OP_ID, password: OP_PASS, account_type: "operator" }),
    });
    const ld: any = await lr.json().catch(() => ({}));
    const token = ld.token || ld?.data?.token || ld.access_token;
    if (!token) return NextResponse.json({ success: false, error: "运营登录失败" }, { status: 502 });

    const cr = await fetch(`${OPRUN}/v1/recruit/copilot/context/${encodeURIComponent(cid)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const cd: any = await cr.json().catch(() => ({}));

    // 二面接通一面:有 aural_interview_id 就去 Aural 库调这场一面已生成的题,替换右栏清单(不再现场 LLM 重生成)。
    if (cd && cd.success !== false && cd.aural_interview_id) {
      const q1 = await pullOneRoundQuestions(String(cd.aural_interview_id));
      if (q1.length) cd.checklist = q1;
      cd.one_round_has_questions = q1.length; // 0 = 这人没真做过一面/没出题(前端可提示)
      cd.one_round_dialog = await pullOneRoundDialog(String(cd.aural_interview_id)); // 一面问答记录
    }

    return NextResponse.json(cd, { status: cr.status });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}

// 二面结论存回 OpRun(转发,带运营 token)
export async function PUT(req: Request) {
  const cid = new URL(req.url).searchParams.get("cid");
  if (!cid) return NextResponse.json({ success: false, error: "Missing cid" }, { status: 400 });
  try {
    const payload = await req.json().catch(() => ({}));
    const lr = await fetch(`${OPRUN}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: OP_ID, password: OP_PASS, account_type: "operator" }),
    });
    const ld: any = await lr.json().catch(() => ({}));
    const token = ld.token || ld?.data?.token || ld.access_token;
    if (!token) return NextResponse.json({ success: false, error: "Operator login failed" }, { status: 502 });

    const sr = await fetch(`${OPRUN}/v1/recruit/copilot/session/${encodeURIComponent(cid)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const sd = await sr.json().catch(() => ({}));
    return NextResponse.json(sd, { status: sr.status });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const cid = new URL(req.url).searchParams.get("cid");
  if (!cid) return NextResponse.json({ success: false, error: "缺少 cid" }, { status: 400 });
  try {
    const payload = await req.json().catch(() => ({}));
    const lr = await fetch(`${OPRUN}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: OP_ID, password: OP_PASS, account_type: "operator" }),
    });
    const ld: any = await lr.json().catch(() => ({}));
    const token = ld.token || ld?.data?.token || ld.access_token;
    if (!token) return NextResponse.json({ success: false, error: "运营登录失败" }, { status: 502 });

    const sr = await fetch(`${OPRUN}/v1/recruit/copilot/conclusion/${encodeURIComponent(cid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const sd = await sr.json().catch(() => ({}));
    return NextResponse.json(sd, { status: sr.status });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}
