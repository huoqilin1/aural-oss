import { apiError, isAuthError, validateApiKey } from "@/lib/api-key-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { generateVoiceSummary } from "@/lib/ai/voice-summary";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;
  const { id } = await params;
  const result = await supabaseAdmin.from("sessions")
    .select("status, summary, interview:interviews!inner(title, projectId, objective, language, assessmentCriteria, questions(text, order, type))")
    .eq("id", id).maybeSingle();
  if (result.error) return apiError("INTERNAL_ERROR", "Session lookup failed", 500);
  if (!result.data) return apiError("NOT_FOUND", "Session not found", 404);
  const joined = result.data.interview;
  const interview = Array.isArray(joined) ? joined[0] : joined;
  if (!interview || !auth.projectIds.includes(interview.projectId)) {
    return apiError("FORBIDDEN", "Session access denied", 403);
  }
  if (result.data.status !== "COMPLETED" || !/^数君招聘\s*·/.test(interview.title)) {
    return apiError("INVALID_STATE", "Completed recruitment session required", 409);
  }
  try {
    // Lost acknowledgement after persistence must not invoke another model chain.
    if (result.data.summary?.trim()) return Response.json({ data: { session_id: id, status: "saved" } });
    await generateVoiceSummary(id, interview.title, interview.objective, interview.language,
      interview.questions, interview.assessmentCriteria);
    return Response.json({ data: { session_id: id, status: "saved" } });
  } catch {
    return apiError("REPORT_UNAVAILABLE", "Report recovery did not complete", 503);
  }
}
