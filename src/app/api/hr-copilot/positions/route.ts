import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// 二面陪面台:取在招岗位 + 岗位职责题(运营 token 调 OpRun)。
const OPRUN = process.env.OPRUN_API_BASE || "https://www.agi.yifx.vip";
const OP_ID = process.env.OPRUN_OPERATOR_ID || "OP01";
const OP_PASS = process.env.OPRUN_OPERATOR_PASS || "123456";

export async function GET() {
  try {
    const lr = await fetch(`${OPRUN}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: OP_ID, password: OP_PASS, account_type: "operator" }),
    });
    const ld: any = await lr.json().catch(() => ({}));
    const token = ld.token || ld?.data?.token || ld.access_token;
    if (!token) return NextResponse.json({ success: false, error: "运营登录失败" }, { status: 502 });
    const r = await fetch(`${OPRUN}/v1/recruit/copilot/positions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}
