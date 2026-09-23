import { resolveHrModelChain } from "../../../../../server/hr-model-control";
import { svgDataUrlToPng } from "@/lib/ai/convert-svg";
import { extractJson } from "@/lib/ai/extract-json";
import { buildSummaryPrompt } from "@/lib/ai/prompts/summary";
import { generateWithFallback } from "@/lib/ai/fallback";
import { REPORT_MODEL, REPORT_FALLBACK_CHAIN } from "@/lib/ai/registry";
import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import {randomUUID} from 'node:crypto';
import {sessionAccessResponse} from '@/server/session-access-http';
import {persistVoiceMessages, type StoredVoiceMessage} from './message-storage';
import {
  handleVoiceSave,
  requireVoiceStorageResult,
  type ActivitySegment,
  type CompletionSession,
  type ProgressSession,
  type VoiceSaveOps,
  type VoiceSavePayload,
} from "./logic";

const log = createLogger("api/voice/save");
const voiceSaveOps: VoiceSaveOps = {
  async insertMessages(sessionId, messages) {
    await persistVoiceMessages(sessionId, messages, {
      async insertIfAbsent(rows) {
        const result = await supabaseAdmin.from('messages').upsert(rows, {onConflict: 'id', ignoreDuplicates: true});
        requireVoiceStorageResult('insert voice messages', result);
      },
      async read(id, messageIds) {
        const result = await supabaseAdmin.from('messages').select('*').eq('sessionId', id).in('id', messageIds);
        return (requireVoiceStorageResult('acknowledge voice messages', result) ?? []) as StoredVoiceMessage[];
      },
    }, randomUUID);
  },
  async loadSessionForCompletion(sessionId) {
    const result = await supabaseAdmin
      .from("sessions")
      .select(
        `*, interview:interviews!inner(title, objective, language, userId, projectId, assessmentCriteria, questions(id, text, order, type, description))`,
      )
      .eq("id", sessionId)
      .order("order", {
        referencedTable: "interviews.questions",
        ascending: true,
      })
      .single();

    const data = requireVoiceStorageResult("load completion session", result);
    return (data as CompletionSession | null) ?? null;
  },
  async loadActivitySegments(sessionId) {
    const result = await supabaseAdmin
      .from("sessions")
      .select("activitySegments")
      .eq("id", sessionId)
      .single();
    const data = requireVoiceStorageResult("load activity segments", result);
    return ((data?.activitySegments as ActivitySegment[]) ?? []);
  },
  async closeOpenSegments(sessionId, now) {
    const loadResult = await supabaseAdmin
      .from("sessions")
      .select("activitySegments")
      .eq("id", sessionId)
      .single();
    const data = requireVoiceStorageResult("load open activity segments", loadResult);
    const segments = ((data?.activitySegments as ActivitySegment[]) ?? []);
    const closed = segments.map((s) =>
      s.leftAt === null ? { ...s, leftAt: now } : s,
    );
    const updateResult = await supabaseAdmin
      .from("sessions")
      .update({ activitySegments: closed })
      .eq("id", sessionId);
    requireVoiceStorageResult("close activity segments", updateResult);
    return closed;
  },
  async loadMessageTimestamps(sessionId) {
    const result = await supabaseAdmin
      .from("messages")
      .select("timestamp")
      .eq("sessionId", sessionId)
      .order("timestamp", { ascending: true });

    const data = requireVoiceStorageResult("load message timestamps", result);
    return (data ?? []).map((r) => r.timestamp as string);
  },
  async loadAnsweredQuestionIds(sessionId) {
    const result = await supabaseAdmin
      .from("messages")
      .select("questionId, content")
      .eq("sessionId", sessionId)
      .eq("role", "USER")
      .not("questionId", "is", null);

    const data = requireVoiceStorageResult("load answered question ids", result);
    return (data ?? [])
      .filter((row) => typeof row.content === 'string' && row.content.trim().length > 0)
      .map((row) => row.questionId as string | null)
      .filter((questionId): questionId is string => Boolean(questionId));
  },
  async loadSessionForProgress(sessionId) {
    const result = await supabaseAdmin
      .from("sessions")
      .select(`*, interview:interviews!inner(questions(*))`)
      .eq("id", sessionId)
      .order("order", {
        referencedTable: "interviews.questions",
        ascending: true,
      })
      .single();

    const data = requireVoiceStorageResult("load progress session", result);
    return (data as ProgressSession | null) ?? null;
  },
  async updateSession(sessionId, payload) {
    const result = await supabaseAdmin
      .from("sessions")
      .update(payload)
      .eq("id", sessionId).select('id').maybeSingle();
    requireVoiceStorageResult("update voice session", result);
    if (!result.data) throw new Error('Interview session disappeared before the save was acknowledged');
  },
  generateSummary,
  log,
  now: () => new Date(),
};

/**
 * POST /api/voice/save
 * Save voice interview messages, optionally complete the session,
 * and fire-and-forget an AI summary/analysis so the interviewee isn't blocked.
 */
export async function POST(req: Request) {
  let payload: VoiceSavePayload;
  try {
    payload = (await req.json()) as VoiceSavePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const denied=await sessionAccessResponse(payload?.sessionId);
  if(denied)return denied;
  const result = await handleVoiceSave(payload, voiceSaveOps);
  return NextResponse.json(result.body, { status: result.status });
}

async function generateSummary(
  sessionId: string,
  interviewTitle: string,
  objective?: string | null,
  language?: string | null,
  questions?: { text: string; order: number; type?: string }[] | null,
  assessmentCriteria?: { name: string; description: string }[] | null,
): Promise<void> {
  try {
    const isRecruitment = /^数君招聘\s*·\s*/.test(interviewTitle);
    let reportRevision: number | null = null;
    if (isRecruitment) {
      const result = await supabaseAdmin.from('sessions')
        .select('status, voiceRevision, completedVoiceRevision').eq('id',sessionId).single();
      const session = requireVoiceStorageResult('load summary version',result);
      if (!session || session.status !== 'COMPLETED' || session.completedVoiceRevision == null ||
          session.voiceRevision !== session.completedVoiceRevision) {
        throw new Error('Recruitment summary requires a confirmed transcript version');
      }
      reportRevision = session.completedVoiceRevision;
    }
    const messagesResult = await supabaseAdmin
      .from("messages")
      .select("*")
      .eq("sessionId", sessionId)
      .order("timestamp", { ascending: true });
    const allMessages = requireVoiceStorageResult('load summary evidence', messagesResult);

    if (!allMessages || allMessages.length === 0) {
      log.info("No messages to summarize");
      return;
    }

    const whiteboardDrawingsRaw = allMessages
      .filter((m) => m.contentType === "WHITEBOARD" && m.whiteboardData)
      .map((m) => {
        const data = m.whiteboardData as Record<string, unknown>;
        return {
          label: (data.label as string) || "Untitled Drawing",
          imageDataUrl: m.whiteboardImageUrl ?? null,
        };
      });

    const whiteboardDrawings = await Promise.all(
      whiteboardDrawingsRaw.map(async (d) => ({
        ...d,
        imageDataUrl: d.imageDataUrl
          ? await svgDataUrlToPng(d.imageDataUrl)
          : null,
      })),
    );

    const codeSnippetsInput = allMessages
      .filter(
        (m) => (m.contentType as string) === "CODE" && m.whiteboardData,
      )
      .map((m) => {
        const data = m.whiteboardData as Record<string, unknown>;
        return {
          label: (data.label as string) || "Untitled Snippet",
          code: (data.code as string) || "",
          language: (data.language as string) || "plaintext",
        };
      })
      .filter((s) => s.code.trim().length > 0);

    const reportChain = await resolveHrModelChain([REPORT_MODEL, ...REPORT_FALLBACK_CHAIN]);
    const textMessages = allMessages
      .filter((m) => m.contentType === "TEXT")
      .map((m) => ({
        role: m.role === "USER" ? "user" : "assistant",
        content: m.content,
      }));
    const drawingsInput =
      whiteboardDrawings.length > 0 ? whiteboardDrawings : null;
    const codeInput = codeSnippetsInput.length > 0 ? codeSnippetsInput : null;

    const promptMessages = buildSummaryPrompt(
      interviewTitle,
      textMessages,
      objective,
      assessmentCriteria,
      questions,
      language,
      drawingsInput,
      codeInput,
    );

    let response;
    try {
      response = await generateWithFallback(reportChain, {
        messages: promptMessages,
        temperature: 0.3,
        maxTokens: 8192,
      });
    } catch (err) {
      const isVisionError =
        err instanceof Error &&
        /image.*not supported|vision.*not supported|does not support.*image/i.test(
          err.message,
        );
      if (isVisionError && drawingsInput?.some((d) => d.imageDataUrl)) {
        log.info("Model does not support images, retrying text-only");
        const textOnlyDrawings = drawingsInput.map((d) => ({
          ...d,
          imageDataUrl: null,
        }));
        const fallbackMessages = buildSummaryPrompt(
          interviewTitle,
          textMessages,
          objective,
          assessmentCriteria,
          questions,
          language,
          textOnlyDrawings,
          codeInput,
        );
        response = await generateWithFallback(reportChain, {
          messages: fallbackMessages,
          temperature: 0.3,
          maxTokens: 8192,
        });
      } else {
        throw err;
      }
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = extractJson(response.content);
    } catch (parseErr) {
      log.error(
        "Invalid summary JSON; response character count:",
        response.content.length,
      );
      throw parseErr;
    }

    const insightsData: Record<string, unknown> = {
      keyInsights: parsed.keyInsights ?? [],
    };
    if (parsed.criteriaEvaluations) {
      insightsData.criteriaEvaluations = parsed.criteriaEvaluations;
    }
    if (parsed.questionEvaluations) {
      insightsData.questionEvaluations = parsed.questionEvaluations;
    }
    if (parsed.researchFindings) {
      insightsData.researchFindings = parsed.researchFindings;
    }
    if (parsed.toneAnalysis) {
      insightsData.toneAnalysis = parsed.toneAnalysis;
    }

    let summaryUpdate = supabaseAdmin
      .from("sessions")
      .update({
        summary: String(parsed.summary ?? ""),
        themes: (parsed.themes as string[]) ?? [],
        sentiment: parsed.sentiment ?? null,
        insights: insightsData,
      })
      .eq("id", sessionId);
    if (isRecruitment) {
      summaryUpdate = summaryUpdate.eq('status','COMPLETED')
        .eq('voiceRevision',reportRevision).eq('completedVoiceRevision',reportRevision);
    }
    const saveSummaryResult = await summaryUpdate.select('id').maybeSingle();
    requireVoiceStorageResult('save generated summary', saveSummaryResult);
    if (!saveSummaryResult.data) throw new Error('Summary version no longer matches the stored transcript');

    const themeCount = Array.isArray(parsed.themes) ? parsed.themes.length : 0;
    const insightCount = Array.isArray(parsed.keyInsights)
      ? parsed.keyInsights.length
      : 0;
    const qEvalCount = Array.isArray(parsed.questionEvaluations)
      ? parsed.questionEvaluations.length
      : 0;
    log.info(
      `Summary generated for session ${sessionId}: ` +
        `${themeCount} themes, ${insightCount} insights, ${qEvalCount} question evaluations`,
    );
  } catch (error) {
    log.error("Summary generation failed:", error);
    throw error;
  }
}
