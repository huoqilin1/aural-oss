import { isAuthError, validateApiKey } from "@/lib/api-key-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/feedback/summary
 * 匿名问卷聚合:只返回计数、平均分与标签频次,不返回任何候选人/笔记内容。
 * 数据范围限定在 API Key 可访问的项目(interviews.projectId ∈ auth.projectIds)。
 */
export async function GET(request: Request) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { data: interviews } = await supabaseAdmin
    .from("interviews")
    .select("id")
    .in("projectId", auth.projectIds);
  const interviewIds = (interviews ?? []).map((row) => row.id);
  if (interviewIds.length === 0) {
    return Response.json({
      data: { count: 0, avg_rating: null, tags: [], since: null },
    });
  }

  const { data: sessions } = await supabaseAdmin
    .from("sessions")
    .select("id")
    .in("interviewId", interviewIds);
  const sessionIds = (sessions ?? []).map((row) => row.id);
  if (sessionIds.length === 0) {
    return Response.json({
      data: { count: 0, avg_rating: null, tags: [], since: null },
    });
  }

  const { data: feedbackRows } = await supabaseAdmin
    .from("session_feedback")
    .select("rating, tags, createdAt")
    .in("sessionId", sessionIds)
    .order("createdAt", { ascending: true });

  const rows = feedbackRows ?? [];
  const avg =
    rows.length > 0
      ? Math.round(
          (rows.reduce((sum, row) => sum + row.rating, 0) / rows.length) * 10,
        ) / 10
      : null;
  const tagCounts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  return Response.json({
    data: {
      count: rows.length,
      avg_rating: avg,
      tags: Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      since: rows.length > 0 ? rows[0].createdAt : null,
    },
  });
}
