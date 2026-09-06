import { svgDataUrlToPng } from "@/lib/ai/convert-svg";
import { extractJson } from "@/lib/ai/extract-json";
import { validateReport } from "@/lib/ai/validate-report";
import { createLogger } from "@/lib/logger";
import { buildSummaryPrompt } from "@/lib/ai/prompts/summary";
import { generateWithFallback } from "@/lib/ai/fallback";
import { generateGovernedText } from "../../../../../server/relay-llm";
import { REPORT_MODEL, REPORT_FALLBACK_CHAIN } from "@/lib/ai/registry";
import { getAuthUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

const log = createLogger("api/ai/summarize");

export async function POST(req: Request) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await req.json();

  try {
    const { data: interviewSession } = await supabaseAdmin
      .from("sessions")
      .select(
        `*, interview:interviews!inner(title, userId, projectId, objective, language, assessmentCriteria, questions(text, order, type)), messages(*)`,
      )
      .eq("id", sessionId)
      .order("order", { referencedTable: "interviews.questions", ascending: true })
      .order("timestamp", { referencedTable: "messages", ascending: true })
      .single();

    if (
      !interviewSession ||
      (interviewSession.interview as { userId: string }).userId !== user.id
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const interview = interviewSession.interview as {
      title: string;
      userId: string;
      projectId: string;
      objective: string | null;
      language: string;
      assessmentCriteria: { name: string; description: string }[] | null;
      questions: { text: string; order: number; type?: string }[];
    };

    const msgs = (interviewSession.messages ?? []) as {
      contentType: string;
      whiteboardData: Record<string, unknown> | null;
      whiteboardImageUrl: string | null;
      role: string;
      content: string;
    }[];

    const criteria = interview.assessmentCriteria;

    const whiteboardDrawingsRaw = msgs
      .filter((m) => m.contentType === "WHITEBOARD" && m.whiteboardData)
      .map((m) => ({
        label: (m.whiteboardData?.label as string) || "Untitled Drawing",
        imageDataUrl: m.whiteboardImageUrl ?? null,
      }));

    const whiteboardDrawings = await Promise.all(
      whiteboardDrawingsRaw.map(async (d) => ({
        ...d,
        imageDataUrl: d.imageDataUrl
          ? await svgDataUrlToPng(d.imageDataUrl)
          : null,
      })),
    );

    const codeSnippetsInput = msgs
      .filter((m) => m.contentType === "CODE" && m.whiteboardData)
      .map((m) => ({
        label: (m.whiteboardData?.label as string) || "Untitled Snippet",
        code: (m.whiteboardData?.code as string) || "",
        language: (m.whiteboardData?.language as string) || "plaintext",
      }))
      .filter((s) => s.code.trim().length > 0);

    const reportChain = [REPORT_MODEL, ...REPORT_FALLBACK_CHAIN];
    const textMessages = msgs
      .filter((m) => m.contentType === "TEXT")
      .map((m) => ({ role: m.role, content: m.content }));
    const drawingsInput =
      whiteboardDrawings.length > 0 ? whiteboardDrawings : null;
    const codeInput = codeSnippetsInput.length > 0 ? codeSnippetsInput : null;

    const messages = buildSummaryPrompt(
      interview.title,
      textMessages,
      interview.objective,
      criteria,
      interview.questions,
      interview.language,
      drawingsInput,
      codeInput,
    );

    let response;
    if (/^数君招聘\s*·/.test(interview.title) && !drawingsInput?.some(drawing => drawing.imageDataUrl)) {
      response = { content: await generateGovernedText({ session_id: sessionId, stage: "interview.summary_report" },
        messages, text => { validateReport(extractJson(text)); }) };
    } else try {
      response = await generateWithFallback(reportChain, {
        messages,
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
          interview.title,
          textMessages,
          interview.objective,
          criteria,
          interview.questions,
          interview.language,
          textOnlyDrawings,
          codeInput,
        );
        response = /^数君招聘\s*·/.test(interview.title)
          ? { content: await generateGovernedText({ session_id: sessionId, stage: "interview.summary_report" },
              fallbackMessages, text => { validateReport(extractJson(text)); }) }
          : await generateWithFallback(reportChain, {
          messages: fallbackMessages,
          temperature: 0.3,
          maxTokens: 8192,
        });
      } else {
        throw err;
      }
    }

    const parsed = extractJson(response.content);
    validateReport(parsed);

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

    const saved = await supabaseAdmin
      .from("sessions")
      .update({
        summary: String(parsed.summary ?? ""),
        themes: (parsed.themes as string[]) ?? [],
        sentiment: parsed.sentiment ?? null,
        insights: insightsData,
      })
      .eq("id", sessionId);
    if (saved.error) throw new Error("report_storage_failed");

    return NextResponse.json(parsed);
  } catch (error) {
    log.error("Summary generation error", { errorType: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json(
      { error: "Failed to generate summary" },
      { status: 500 },
    );
  }
}
