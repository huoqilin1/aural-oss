import { assertInterviewProjectAccess } from "@/app/api/v1/_lib/interview-access";
import {
    apiError,
    isAuthError,
    validateApiKey,
} from "@/lib/api-key-auth";
import { nanoid } from "@/lib/id";
import { supabaseAdmin } from "@/lib/supabase/admin";

const APP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? "https://aural-ai.com";

type CandidateInput = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  notes?: unknown;
  externalCorrelationId?: unknown;
};

function normalizeCandidateInput(raw: unknown): CandidateInput | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as CandidateInput;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { id: interviewId } = await params;

  const access = await assertInterviewProjectAccess(interviewId, auth.projectIds);
  if (access instanceof Response) return access;

  const { data: candidates, error } = await supabaseAdmin
    .from("candidates")
    .select(
      "id, name, email, phone, notes, inviteToken, sessionId, createdAt",
    )
    .eq("interviewId", interviewId)
    .order("createdAt", { ascending: false });

  if (error) {
    return apiError("INTERNAL_ERROR", error.message, 500);
  }

  return Response.json({ data: candidates ?? [] });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  const { id: interviewId } = await params;

  const access = await assertInterviewProjectAccess(interviewId, auth.projectIds);
  if (access instanceof Response) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("BAD_REQUEST", "Invalid JSON body", 400);
  }

  const rawItems = Array.isArray(body) ? body : [body];
  if (rawItems.length === 0) {
    return apiError("BAD_REQUEST", "At least one candidate is required", 400);
  }
  if (rawItems.length > 500) {
    return apiError("BAD_REQUEST", "Maximum 500 candidates per request", 400);
  }

  const rows: {
    interviewId: string;
    name: string;
    email: string | null;
    phone: string | null;
    notes: string | null;
    inviteToken: string;
    externalCorrelationId: string | null;
  }[] = [];

  for (const item of rawItems) {
    const c = normalizeCandidateInput(item);
    if (!c) {
      return apiError("BAD_REQUEST", "Each candidate must be an object", 400);
    }

    const name =
      typeof c.name === "string" ? c.name.trim() : "";
    const emailRaw = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
    const phone = typeof c.phone === "string" ? c.phone.trim() || null : null;
    const notes = typeof c.notes === "string" ? c.notes.trim() || null : null;
    const externalCorrelationId =
      typeof c.externalCorrelationId === "string" && c.externalCorrelationId.trim()
        ? c.externalCorrelationId.trim()
        : null;

    if (!Array.isArray(body) && externalCorrelationId) {
      const { data: existing } = await (supabaseAdmin as any)
        .from("candidates")
        .select("id, name, email, phone, notes, inviteToken, sessionId, createdAt, updatedAt")
        .eq("interviewId", interviewId)
        .eq("externalCorrelationId", externalCorrelationId)
        .maybeSingle();
      if (existing) {
        return Response.json({
          data: [{
            ...existing,
            inviteUrl: `${APP_BASE}/invite/${existing.inviteToken as string}`,
          }],
          reused: true,
        });
      }
    }

    rows.push({
      interviewId,
      name,
      email: emailRaw || null,
      phone,
      notes,
      inviteToken: nanoid(12),
      externalCorrelationId,
    });
  }

  const { data: created, error } = await (supabaseAdmin as any)
    .from("candidates")
    .insert(rows)
    .select(
      "id, name, email, phone, notes, inviteToken, sessionId, createdAt, updatedAt",
    );

  if (error) {
    const correlationId = rows.length === 1 ? rows[0]?.externalCorrelationId : null;
    if (correlationId && error.code === "23505") {
      const { data: existing } = await (supabaseAdmin as any)
        .from("candidates")
        .select("id, name, email, phone, notes, inviteToken, sessionId, createdAt, updatedAt")
        .eq("interviewId", interviewId)
        .eq("externalCorrelationId", correlationId)
        .single();
      if (existing) {
        return Response.json({
          data: [{
            ...existing,
            inviteUrl: `${APP_BASE}/invite/${existing.inviteToken as string}`,
          }],
          reused: true,
        });
      }
    }
    return apiError("INTERNAL_ERROR", error.message, 500);
  }

  const data = (created ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    inviteUrl: `${APP_BASE}/invite/${row.inviteToken as string}`,
  }));

  return Response.json({ data });
}
