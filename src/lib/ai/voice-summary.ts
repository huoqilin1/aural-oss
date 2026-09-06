import { svgDataUrlToPng } from "@/lib/ai/convert-svg";
import { extractJson } from "@/lib/ai/extract-json";
import { validateReport } from "@/lib/ai/validate-report";
import { buildSummaryPrompt } from "@/lib/ai/prompts/summary";
import { generateWithFallback } from "@/lib/ai/fallback";
import { generateGovernedText } from "../../../server/relay-llm";
import { REPORT_MODEL, REPORT_FALLBACK_CHAIN } from "@/lib/ai/registry";
import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";

const log = createLogger("voice-summary");

export async function generateVoiceSummary(
  sessionId: string,
  interviewTitle: string,
  objective?: string | null,
  language?: string | null,
  questions?: { text: string; order: number; type?: string }[] | null,
  assessmentCriteria?: { name: string; description: string }[] | null,
): Promise<void> {
  try {
    const { data: allMessages } = await supabaseAdmin
      .from("messages")
      .select("*")
      .eq("sessionId", sessionId)
      .order("timestamp", { ascending: true });

    if (!allMessages || allMessages.length === 0) {
      throw new Error("report_messages_missing");
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

    const reportChain = [REPORT_MODEL, ...REPORT_FALLBACK_CHAIN];
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
    if (/^数君招聘\s*·/.test(interviewTitle) && !drawingsInput?.some(drawing => drawing.imageDataUrl)) {
      response = { content: await generateGovernedText({ session_id: sessionId, stage: "interview.voice_report" },
        promptMessages, text => { validateReport(extractJson(text)); }) };
    } else try {
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
        response = /^数君招聘\s*·/.test(interviewTitle)
          ? { content: await generateGovernedText({ session_id: sessionId, stage: "interview.voice_report" },
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

    let parsed: Record<string, unknown>;
    try {
      parsed = extractJson(response.content);
      validateReport(parsed);
    } catch (parseErr) {
      log.error("Report JSON validation failed");
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
    log.error("Summary generation failed", { errorType: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}
