/**
 * WebSocket relay server using separate ASR 2.0 + TTS 2.0 services.
 *
 * Browser ←→ this relay ←→ Volcengine ASR 2.0 (speech recognition)
 *                         ←→ Volcengine TTS 2.0 (speech synthesis)
 *                         ←→ Gemini / Kimi / MiniMax LLM (response generation)
 *
 * Architecture (Phase 2 — cost-optimized):
 *   - ASR via Volcengine BigModel streaming ASR (volcengine-asr.ts)
 *   - TTS via Volcengine SeedTTS 2.0 HTTP streaming (volcengine-tts.ts)
 *   - Chat intelligence via external LLM (unchanged from Phase 1)
 *
 * Key features:
 * - Per-question interview flow with LLM-powered context summarization
 * - Transition triggers from both user (button/voice) and agent (keyword detection)
 * - Barge-in / interruption: ASR activity cancels in-flight TTS
 * - Accumulated context passed between questions
 *
 * Usage:  npx tsx server/voice-relay.ts
 */
import { randomUUID } from "crypto";
import { config } from "dotenv";
import { WebSocket, WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";
import { bt } from "../src/lib/i18n";
import { createLogger } from "../src/lib/logger";
import type { RelayLlmRoute } from "../src/lib/relay-llm-route";
import {
  isProgressiveOpeningOnly,
  mergeExpandedQuestionSet,
  shouldWaitForQuestionExpansion,
} from "../src/lib/voice/dynamic-question-sync";
import {
  assertRelayLlmReady,
  callRelayLLM,
  logRelayLlmStartup,
} from "./relay-llm";
import {
    collapseInternalAsrRepetitions,
    decidePendingFinalSpeechHold,
    evaluateTranscriptManualAdvance,
    failClosedRecruitmentResumeBudget,
    finalizeTurnBudgetResponse,
    mergePersistedRecruitmentFollowUpBudget,
    readPersistedRecruitmentFollowUpBudget,
    shouldConsumeFollowUpBudget,
    isRecruitmentConversationControl,
    recruitmentMetricEvidenceFollowUp,
    isUserEndRequest,
    isUserSkipRequest,
    mergeAsrSegments,
    mergePendingAsrInterim,
    responseInvitesUserReply,
    shouldHoldBargeInInterimForFinal,
    shouldSuppressAnsweredAsrFinal,
    shouldSuppressRecentAsrFinal,
    summarizeRecruitmentResumeBudget,
    trimCrossTurnOverlap,
    type RecentAsrFinal,
} from "./voice-relay-helpers";
import { PROMPTS, SPOKEN } from "./voice-relay-prompts";
import {
    BIGMODEL_ASR_URL,
    buildBigModelAudioRequest,
    buildBigModelFullRequest,
    buildBigModelHeaders,
    parseAsrResponse,
    resolveBigModelAsrLanguage,
    type BigModelAsrConfig,
} from "./volcengine-asr";
import {
    resolveTtsAuthConfig,
    resolveTtsSpeechRate,
    synthesizeSpeech,
    type TtsAuthConfig,
    type TtsSynthesisOptions,
} from "./volcengine-tts";
import {
  planSessionFinalization,
  isTerminalSessionStatus,
  shouldPersistSessionStatus,
  type LiveSessionRecord,
} from "./session-finalization";
import { SessionConnectionRegistry } from "./session-connection-registry";
import { loadInterviewRelayLlmRoute } from "./interview-llm-route";

const log = createLogger("voice-relay");

config({ path: ".env.local", override: true });
config({ path: ".env" });

const dynamicQuestionClient =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
    : null;

// AbortController.abort() in Node.js can cause unhandled rejections from
// fetch internals — these are expected during TTS barge-in cancellation.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof DOMException && reason.name === "AbortError") return;
  log.error("Unhandled rejection:", reason);
});

// ── Configuration ───────────────────────────────────────────────────

const RELAY_PORT = Number(process.env.VOICE_RELAY_PORT) || 8766;

// ASR config — X-Api-Key auth (new console) for ASR 2.0
const ASR_APP_ID = process.env.DOUBAO_APP_ID || process.env.DOUBAO_APP_KEY || "";
const ASR_ACCESS_TOKEN = process.env.DOUBAO_ACCESS_TOKEN || "";
const ASR_API_KEY = process.env.DOUBAO_API_KEY || "";
const ASR_RESOURCE_ID = process.env.DOUBAO_ASR_RESOURCE_ID || "volc.seedasr.sauc.duration";

/** Volc BigModel endpointing / speech timing bounds (ms). Docs: min 200ms for end window. */
const ASR_ENDPOINT_MIN_MS = 200;
// 王总 2026-09-03 拍板：说完判定 = 平台上限 15000ms（时间短会打扰候选人说话），
// 想词/断句停顿 ≤15 秒都不判"说完"；env DOUBAO_ASR_END_WINDOW_MS 可再覆盖。
const ASR_END_WINDOW_DEFAULT_MS = 15_000;
const ASR_END_WINDOW_MAX_MS = 15_000;
const ASR_FORCE_SPEECH_DEFAULT_MS = 0;
const ASR_FORCE_SPEECH_MAX_MS = 60_000;

/**
 * Volc BigModel: silence longer than end_window_size (ms) forces definite=true and ends the turn.
 * Override: DOUBAO_ASR_END_WINDOW_MS
 */
const ASR_END_WINDOW_MS = Math.max(
  ASR_ENDPOINT_MIN_MS,
  Math.min(
    ASR_END_WINDOW_MAX_MS,
    Number(process.env.DOUBAO_ASR_END_WINDOW_MS) || ASR_END_WINDOW_DEFAULT_MS,
  ),
);
/**
 * Volc BigModel force_to_speech_time can force a definite result while speech is still ongoing.
 * Keep it disabled by default so candidate answers are ended by silence (end_window_size), not by
 * an arbitrary wall-clock chunk. Override with DOUBAO_ASR_FORCE_SPEECH_MS if a forced cap is needed.
 */
const parsedForceSpeechMs = Number(process.env.DOUBAO_ASR_FORCE_SPEECH_MS);
const ASR_FORCE_SPEECH_MS = Number.isFinite(parsedForceSpeechMs)
  ? Math.max(0, Math.min(ASR_FORCE_SPEECH_MAX_MS, parsedForceSpeechMs))
  : ASR_FORCE_SPEECH_DEFAULT_MS;
const ASR_FINAL_COALESCE_MS = Math.max(
  0,
  Math.min(
    5_000,
    Number(process.env.DOUBAO_ASR_FINAL_COALESCE_MS) || 2_200,
  ),
);
const ASR_LONG_FINAL_COALESCE_MS = Math.max(
  ASR_FINAL_COALESCE_MS,
  Math.min(
    8_000,
    Number(process.env.DOUBAO_ASR_LONG_FINAL_COALESCE_MS) || 5_000,
  ),
);
const ASR_SHORT_FINAL_COALESCE_MS = Math.max(
  0,
  Math.min(
    ASR_FINAL_COALESCE_MS,
    // 王总 2026-09-03：500→1200，开场短句(≤9 词)停顿后不再 0.5s 就被快速提交成"完整回答"。
    Number(process.env.DOUBAO_ASR_SHORT_FINAL_COALESCE_MS) || 1_200,
  ),
);
const ASR_ACTIVE_SPEECH_HOLD_MS = Math.max(
  0,
  Math.min(
    3_000,
    Number(process.env.DOUBAO_ASR_ACTIVE_SPEECH_HOLD_MS) || 1_200,
  ),
);
const ASR_PENDING_FINAL_QUIET_MS = Math.max(
  ASR_ACTIVE_SPEECH_HOLD_MS,
  Math.min(
    4_000,
    Number(process.env.DOUBAO_ASR_PENDING_FINAL_QUIET_MS) || 1_600,
  ),
);
const ASR_MAX_ACTIVE_SPEECH_HOLD_MS = Math.max(
  0,
  Math.min(
    120_000,
    Number(process.env.DOUBAO_ASR_MAX_ACTIVE_SPEECH_HOLD_MS) || 60_000,
  ),
);
const ASR_AUDIO_ACTIVITY_RMS_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    // 王总 2026-09-03：0.018→0.014，小声/离麦远说话不再被当成沉默而提前切段。
    Number(process.env.DOUBAO_ASR_AUDIO_ACTIVITY_RMS_THRESHOLD) || 0.014,
  ),
);
const ASR_SESSION_MAX_CONTINUOUS_SPEECH_MS = Math.max(
  10_000,
  Math.min(
    120_000,
    Number(process.env.DOUBAO_ASR_SESSION_MAX_CONTINUOUS_SPEECH_MS) || 30_000,
  ),
);
const ASR_STUCK_TEXT_ROTATE_MS = Math.max(
  3_000,
  Math.min(
    15_000,
    Number(process.env.DOUBAO_ASR_STUCK_TEXT_ROTATE_MS) || 5_000,
  ),
);
const ASR_RECENT_FINAL_REPLAY_TTL_MS = 90_000;
const ASR_RECENT_FINAL_REPLAY_MIN_UNITS = 8;
// 开讲前门控(王总 2026-09-03 第5项):回复已生成但用户仍在说话时,最多等
// USER_SPEAK_GATE_MAX_WAIT_MS(期间有新内容则放弃本次),确认静默
// USER_SPEAK_GATE_QUIET_MS 后才开讲,杜绝"AI 抢在候选人答题中开口"。
const USER_SPEAK_GATE_QUIET_MS = Math.max(
  0,
  Number(process.env.VOICE_SPEAK_GATE_QUIET_MS) || 700,
);
const USER_SPEAK_GATE_MAX_WAIT_MS = Math.max(
  0,
  Number(process.env.VOICE_SPEAK_GATE_MAX_WAIT_MS) || 2_500,
);

/**
 * Volc split-noise finals often arrive soon after the assistant line is committed; after this much
 * wall time since that line, treat the user final as a real reply (no phrase-shape / keyword rules).
 */
const SPLIT_NOISE_MIN_PAUSE_AFTER_ASSISTANT_MS = 5500;

// TTS config
const TTS_APP_ID = process.env.DOUBAO_APP_ID || "";
const TTS_ACCESS_TOKEN = process.env.DOUBAO_ACCESS_TOKEN || "";
const TTS_API_KEY = process.env.DOUBAO_API_KEY || "";
const TTS_RESOURCE_ID = process.env.DOUBAO_TTS_RESOURCE_ID || "seed-tts-2.0";
const TTS_VOICE_ZH = process.env.DOUBAO_VOICE_ZH || "";
const TTS_VOICE_EN = process.env.DOUBAO_VOICE_EN || "";
const TTS_SPEECH_RATE = resolveTtsSpeechRate();

function getTtsAuth(): TtsAuthConfig {
  return resolveTtsAuthConfig({
    appId: TTS_APP_ID,
    accessToken: TTS_ACCESS_TOKEN,
    apiKey: TTS_API_KEY,
    resourceId: TTS_RESOURCE_ID,
  });
}

function getTtsOptions(language?: string): TtsSynthesisOptions {
  const isZh = language?.toLowerCase().startsWith("zh");
  const defaultVoice = isZh
    ? "zh_female_shuangkuaisisi_uranus_bigtts"
    : "en_female_dacey_uranus_bigtts";
  const voiceType = (isZh ? TTS_VOICE_ZH : TTS_VOICE_EN) || defaultVoice;
  return {
    speaker: voiceType,
    format: "pcm",
    sampleRate: 24000,
    ...(TTS_SPEECH_RATE != null ? { speechRate: TTS_SPEECH_RATE } : {}),
  };
}

if (!ASR_ACCESS_TOKEN && !ASR_API_KEY) {
  log.error("Missing DOUBAO_ACCESS_TOKEN or DOUBAO_API_KEY in .env.local");
  process.exit(1);
}

// ── Interview context type ──────────────────────────────────────────

interface InterviewContext {
  interviewId?: string;
  /** 真实会话 ID(tRPC 建的 sessions 行):relay 据此做服务端收尾落库 */
  sessionId?: string;
  /** 面试硬限(分钟):服务端兜底,浏览器关掉/后台挂着也必须按时结束 */
  timeLimitMinutes?: number | null;
  title: string;
  objective?: string | null;
  aiName: string;
  aiTone: string;
  language: string;
  followUpDepth: string;
  startQuestionIndex?: number;
  questions: Array<{
    id?: string;
    text: string;
    type: string;
    description?: string | null;
    options?: { options: string[]; allowMultiple?: boolean } | null;
    timeLimitSeconds?: number | null;
    order: number;
  }>;
}

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

function normalizeUtteranceForEcho(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Volc often picks up played TTS; avoid treating that as a user line on suppression flush. */
function looksLikeAssistantPlaybackEcho(userText: string, transcript: TranscriptEntry[]): boolean {
  const u = normalizeUtteranceForEcho(userText);
  if (u.length < 10) return false;
  for (let i = transcript.length - 1; i >= Math.max(0, transcript.length - 4); i--) {
    const e = transcript[i];
    if (e?.role !== "assistant" || !e.text) continue;
    const a = normalizeUtteranceForEcho(e.text);
    if (!a) continue;
    if (a.includes(u)) return true;
    if (u.length >= 28 && u.includes(a.slice(0, Math.min(36, a.length)))) return true;
  }
  return false;
}

interface AgentContext {
  memory: string;
  codeContent?: string;
  codeLanguage?: string;
  whiteboardDescription?: string;
  whiteboardLoading?: boolean;
  correctionGuard?: string;
  antiRepetition?: string;
}

// ── Vision LLM for whiteboard description ────────────────────────────

const VISION_LLM_API_KEY = process.env.KIMI_API_KEY || "";
const VISION_LLM_BASE_URL = process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1";
const VISION_LLM_MODEL = process.env.VISION_LLM_MODEL || "kimi-k2.5";
/** Used when the primary model returns empty text after parsing (vision-specific, shorter path to answer). */
const VISION_LLM_RETRY_MODEL = process.env.VISION_LLM_RETRY_MODEL || "moonshot-v1-8k-vision-preview";
const VISION_LLM_MAX_TOKENS = 1024;
const WHITEBOARD_SNAPSHOT_REQUEST_TIMEOUT_MS = 2500;
const WHITEBOARD_VISION_INLINE_TIMEOUT_MS = 1200;
const WHITEBOARD_VISION_FOLLOW_UP_MAX_WAIT_MS = 20_000;

/** Kimi API rejects custom temperature for these models — omit the field (see kimi.ts / vision-compare). */
const VISION_MODELS_OMIT_TEMPERATURE = new Set(["kimi-k2.5"]);

/**
 * Strip Kimi-style redacted reasoning blocks (see scripts/vision-compare stripThinking).
 * Low max_tokens can leave the whole completion inside one — second replace clears that tail.
 */
function stripVisionReasoning(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
  result = result.replace(/<think>[\s\S]*/gi, "").trim();
  return result;
}

function normalizeChatMessageContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object" && "type" in part) {
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("");
}

async function callWhiteboardVisionApi(
  imageDataUrl: string,
  userPrompt: string,
  model: string,
): Promise<{ text: string; finishReason?: string }> {
  const omitTemp = VISION_MODELS_OMIT_TEMPERATURE.has(model);
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl } },
          { type: "text", text: userPrompt },
        ],
      },
    ],
    max_tokens: VISION_LLM_MAX_TOKENS,
  };
  if (!omitTemp) {
    body.temperature = 0.2;
  }

  const res = await fetch(`${VISION_LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VISION_LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    log.error(`Vision LLM error (${model}): ${res.status} — ${errBody.slice(0, 200)}`);
    return { text: "" };
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  };
  const choice = data?.choices?.[0];
  const raw = normalizeChatMessageContent(choice?.message?.content);
  const text = stripVisionReasoning(raw).trim();
  return { text, finishReason: choice?.finish_reason };
}

async function describeWhiteboard(imageDataUrl: string, isZh: boolean): Promise<string> {
  if (!VISION_LLM_API_KEY || !imageDataUrl) return "";

  const userPrompt = isZh
    ? "用1-2句话描述这个白板上画了什么。重点说明结构、组件和它们之间的关系。只输出描述本体，不要输出思考过程。"
    : "Describe what is drawn on this whiteboard in 1-2 sentences. Focus on the structure, components, and relationships shown. Output only the description itself, no reasoning or preamble.";

  const startMs = Date.now();
  try {
    let { text, finishReason } = await callWhiteboardVisionApi(
      imageDataUrl,
      userPrompt,
      VISION_LLM_MODEL,
    );

    if (
      !text &&
      VISION_LLM_RETRY_MODEL &&
      VISION_LLM_RETRY_MODEL !== VISION_LLM_MODEL
    ) {
      log.warn(
        `Vision LLM (${VISION_LLM_MODEL}) returned empty${finishReason ? ` (finish=${finishReason})` : ""} — retrying with ${VISION_LLM_RETRY_MODEL}`,
      );
      ({ text, finishReason } = await callWhiteboardVisionApi(
        imageDataUrl,
        userPrompt,
        VISION_LLM_RETRY_MODEL,
      ));
    }

    const elapsed = Date.now() - startMs;
    if (!text) {
      log.warn(
        `Vision LLM returned empty (${elapsed}ms)${finishReason ? ` finish=${finishReason}` : ""}`,
      );
      return "";
    }

    log.info(
      `Vision LLM (${elapsed}ms): "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`,
    );
    return text;
  } catch (err) {
    log.error("Vision LLM failed:", err);
    return "";
  }
}

// ── Correction detection ─────────────────────────────────────────────

const CORRECTION_PATTERNS_ZH = [
  /请重新/i, /请选择/i, /只能选一个/i, /请再想想/i,
  /需要选择/i, /请再考虑/i, /选择一个/i, /不太对/i,
];
const CORRECTION_PATTERNS_EN = [
  /please reconsider/i, /choose only one/i, /pick (?:only )?one/i,
  /need to (?:select|choose|pick)/i, /try again/i, /that'?s not quite/i,
  /please select/i, /must pick/i, /can only choose one/i,
];

function isCorrection(text: string, isZh: boolean): boolean {
  const patterns = isZh ? CORRECTION_PATTERNS_ZH : CORRECTION_PATTERNS_EN;
  return patterns.some((p) => p.test(text));
}

// ── Repetition detection ─────────────────────────────────────────────

function normalizeForComparison(s: string): string {
  return s.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, "");
}

function isSimilarResponse(a: string, b: string): boolean {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  return longer.includes(shorter) || shorter.length / longer.length > 0.8;
}

// ── Transition detection ────────────────────────────────────────────

const FAST_NEXT_PATTERNS = [
  /^(?:那个?|好的?|嗯|呃|噢|哦|行|就|这样|ok|okay)*[\s,，、。]*(?:下一个问题|下一题|下一道|跳过|已完成|回答完了|我回答完了|答完了|我答完了|回答完毕|说完了|我说完了|讲完了|我讲完了|继续下一个?|继续)[\s,，、。]*(?:吧|了|啦|哈|呢|啊|哦|嗯|谢谢|就这样|就这些)*[\s,，、。!！~]*$/i,
];

const FAST_PREV_PATTERNS = [
  /^(?:上一个问题|上一题|previous\s*question)\.?$/i,
];

const USER_PREV_PATTERNS = [
  /(?:go|move|get)\s+back\s+(?:to\s+)?(?:the\s+)?(?:previous|last|prior)/i,
  /(?:return|go)\s+to\s+(?:the\s+)?(?:previous|last|prior)\s+(?:question|one|problem)/i,
  /(?:can|could)\s+(?:we|you|i)\s+(?:go|move|get)\s+back/i,
  /(?:let'?s|please|i\s+(?:want|need)\s+to)\s+(?:go|move|get)\s+back/i,
  /(?:revisit|re-visit)\s+(?:the\s+)?(?:previous|last|prior)/i,
  /previous\s+question/i,
  /(?:回到|返回|回去)(?:上一(?:个问题|题)|之前(?:的问题|那题))/,
  /(?:我(?:想|要|需要)|请|可以)(?:回到|返回|回去)上一/,
];

const IMPLICIT_NEXT_PATTERNS = [
  /let'?s\s+(?:move|proceed|go)\s+(?:on|forward)\s+(?:to\s+)?(?:the\s+)?next/i,
  /(?:move|proceed|go)\s+to\s+the\s+next\s+question/i,
  /we(?:'ll|\s+will)\s+(?:move|proceed|go)\s+(?:on|to\s+the\s+next)/i,
  /我们(?:进入|开始|来看)下一(?:个问题|题)/,
  /(?:进入|开始)下一(?:个问题|题)/,
  /那我们(?:继续|进入)下一/,
];

function hasImplicitTransition(text: string): boolean {
  return IMPLICIT_NEXT_PATTERNS.some((p) => p.test(text));
}

const IMPLICIT_PREV_PATTERNS = [
  /(?:go|going)\s+back\s+to\s+(?:the\s+)?previous/i,
  /(?:return|returning)\s+to\s+(?:the\s+)?previous/i,
  /(?:revisit|re-visit)\s+(?:the\s+)?previous/i,
  /(?:let'?s|we(?:'ll|\s+can))\s+(?:go\s+back|return|revisit)/i,
  /(?:回到|返回|回去)(?:上一(?:个问题|题)|之前(?:的问题|那题))/,
  /我们(?:回到|返回)上一/,
];

function hasImplicitPrevTransition(text: string): boolean {
  return IMPLICIT_PREV_PATTERNS.some((p) => p.test(text));
}

function looksLikeQuestion(text: string): boolean {
  if (/[？?]/.test(text)) return true;
  if (/\b(?:could|can|would)\s+you\s+(?:share|explain|elaborate|describe|tell|walk|talk|give|provide)/i.test(text)) return true;
  if (/\bplease\s+(?:share|explain|elaborate|describe|tell|walk|talk|give|provide)/i.test(text)) return true;
  if (/\b(?:how|what|why|where|when)\s+(?:do|did|does|would|could|can|will|is|are|was|were)\s+(?:you|they|the|this|that|it)\b/i.test(text)) return true;
  if (/请.{0,4}(?:分享|描述|解释|说明|告诉|讲述?|谈谈?)/.test(text)) return true;
  if (/能否.{0,4}(?:分享|描述|解释|说明|告诉|讲述?|谈谈?)/.test(text)) return true;
  return false;
}

function replyKeepsConversationOpen(text: string, isZh: boolean): boolean {
  return looksLikeQuestion(text) || responseInvitesUserReply(text, isZh);
}

function isFastNextRequest(text: string): boolean {
  const t = text.trim();
  return FAST_NEXT_PATTERNS.some((p) => p.test(t));
}

function isFastPrevRequest(text: string): boolean {
  const t = text.trim();
  return FAST_PREV_PATTERNS.some((p) => p.test(t));
}

function isUserPrevRequest(text: string): boolean {
  return USER_PREV_PATTERNS.some((p) => p.test(text));
}

let lastContinuationFragmentLog: { text: string; at: number } | null = null;
function logContinuationFragmentIgnored(text: string): void {
  const t = text.trim();
  const now = Date.now();
  if (
    lastContinuationFragmentLog &&
    lastContinuationFragmentLog.text === t &&
    now - lastContinuationFragmentLog.at < 2_000
  ) {
    return;
  }
  lastContinuationFragmentLog = { text: t, at: now };
  log.info(
    `ASR split-noise: ignoring short follow-up final after long user turn: "${t.slice(0, 72)}..."`,
  );
}

/**
 * Volc often emits a second definite soon after the first — a tail fragment or noise — especially
 * after a short TTS segment. If the new final arrives soon after the latest *transcript* assistant
 * line, treat obvious mid-phrase tails as noise; after SPLIT_NOISE_MIN_PAUSE_AFTER_ASSISTANT_MS,
 * the same text is handled as a real user reply (pause-based, no keyword allowlist).
 */
function shouldIgnoreVolcContinuationFragment(
  text: string,
  transcript: TranscriptEntry[],
  lastAssistantMessageAtMs: number,
  isZhLocale: boolean,
): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  if (
    isUserEndRequest(t) ||
    isUserSkipRequest(t) ||
    isFastNextRequest(t) ||
    isFastPrevRequest(t) ||
    isUserPrevRequest(t)
  ) {
    return false;
  }

  const now = Date.now();
  if (lastAssistantMessageAtMs <= 0) return false;
  const pauseAfterAssistant = now - lastAssistantMessageAtMs;
  if (pauseAfterAssistant >= SPLIT_NOISE_MIN_PAUSE_AFTER_ASSISTANT_MS) return false;

  let lastUserIdx = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return false;

  const lastUser = transcript[lastUserIdx].text.trim();
  const hadAssistantAfter = transcript
    .slice(lastUserIdx + 1)
    .some((e) => e.role === "assistant");
  if (!hadAssistantAfter) return false;

  if (isZhLocale) {
    const compactLast = lastUser.replace(/\s+/g, "");
    const compactT = t.replace(/\s+/g, "");
    if (compactLast.length < 40) return false;
    if (compactT.length < 8 || compactT.length > 36) return false;
  } else {
    if (lastUser.length < 70) return false;
    const wc = t.split(/\s+/).filter(Boolean).length;
    if (t.length > 52 || wc > 8) return false;

    const looksLikeMidPhraseTail =
      /^(?:and|or|but|if|for|to)\s+/i.test(t) ||
      /^(?:the|a|an)\s+\w+\s*\.?\s*$/i.test(t);

    if (!looksLikeMidPhraseTail) return false;
  }

  logContinuationFragmentIgnored(t);
  return true;
}

// ── Build prompts from interview context ─────────────────────────────

function isChineseInterview(ctx: InterviewContext): boolean {
  return (
    ctx.language === "zh" || ctx.language.toLowerCase().includes("chinese")
  );
}

function buildChoiceSuffix(
  type: string,
  opts: { options: string[]; allowMultiple?: boolean } | null | undefined,
  isZh: boolean,
): string {
  if (
    (type !== "SINGLE_CHOICE" && type !== "MULTIPLE_CHOICE") ||
    !opts?.options?.length
  ) {
    return "";
  }
  const labels = opts.options
    .map((o, i) => `${String.fromCharCode(65 + i)}, ${o}`)
    .join("; ");
  return bt(isZh, type === "MULTIPLE_CHOICE"
    ? SPOKEN.multipleChoiceSuffix(labels)
    : SPOKEN.singleChoiceSuffix(labels));
}

function buildGreeting(ctx: InterviewContext): string {
  const isZh = isChineseInterview(ctx);
  const firstQ = ctx.questions.sort((a, b) => a.order - b.order)[0];
  const q1Text = firstQ?.text || bt(isZh, SPOKEN.defaultQuestion);

  const opts = firstQ?.options as { options: string[]; allowMultiple?: boolean } | null | undefined;
  const isCodingOrWb = firstQ && (firstQ.type === "CODING" || firstQ.type === "WHITEBOARD");
  const spokenQuestion = isCodingOrWb
    ? bt(isZh, SPOKEN.codingWbIntro(firstQ.type))
    : `${q1Text}${buildChoiceSuffix(firstQ?.type ?? "", opts, isZh)}`;

  return bt(isZh, SPOKEN.greeting(ctx.aiName, ctx.title, ctx.questions.length, spokenQuestion));
}

function buildTransitionSayHello(
  questionIndex: number,
  nextQuestion: { text: string; type: string; description?: string | null; options?: { options: string[]; allowMultiple?: boolean } | null },
  isZh: boolean
): string {
  const isCodingOrWb = nextQuestion.type === "CODING" || nextQuestion.type === "WHITEBOARD";
  const opts = nextQuestion.options as { options: string[]; allowMultiple?: boolean } | null | undefined;
  const qNum = questionIndex + 1;

  if (nextQuestion.description === "oprun_dimension:candidate_questions") {
    return isZh
      ? `好的，八道正式计分题已经完成。接下来进入交流环节。${nextQuestion.text}`
      : `Thank you. The eight scored questions are complete. We will now move to the candidate Q&A. ${nextQuestion.text}`;
  }

  if (isCodingOrWb) {
    return bt(isZh, SPOKEN.transition.codingWb(qNum, bt(isZh, SPOKEN.codingWbIntro(nextQuestion.type))));
  }
  return bt(isZh, SPOKEN.transition.normal(qNum, nextQuestion.text, buildChoiceSuffix(nextQuestion.type, opts, isZh)));
}

function buildResumeGreeting(ctx: InterviewContext, questionIndex: number): string {
  const isZh = isChineseInterview(ctx);
  const sortedQs = ctx.questions.sort((a, b) => a.order - b.order);
  const q = sortedQs[questionIndex];
  const qNum = questionIndex + 1;

  const opts = q?.options as { options: string[]; allowMultiple?: boolean } | null | undefined;
  const isCodingOrWb = q && (q.type === "CODING" || q.type === "WHITEBOARD");

  if (isCodingOrWb) {
    return bt(isZh, SPOKEN.resume.codingWb(qNum, bt(isZh, SPOKEN.codingWbIntro(q.type))));
  }
  return bt(isZh, SPOKEN.resume.normal(qNum, q?.text || "", buildChoiceSuffix(q?.type ?? "", opts, isZh)));
}

function buildReturnSayHello(
  questionIndex: number,
  question: { text: string; type: string; options?: { options: string[]; allowMultiple?: boolean } | null },
  isZh: boolean
): string {
  const isCodingOrWb = question.type === "CODING" || question.type === "WHITEBOARD";
  const qNum = questionIndex + 1;

  if (isCodingOrWb) {
    return bt(isZh, SPOKEN.returnTo.codingWb(qNum, bt(isZh, SPOKEN.codingWbIntro(question.type, "continue"))));
  }

  const opts = question.options as { options: string[]; allowMultiple?: boolean } | null | undefined;
  let optionsSuffix = "";
  const isChoice = question.type === "SINGLE_CHOICE" || question.type === "MULTIPLE_CHOICE";
  if (isChoice && opts?.options?.length) {
    const labels = opts.options.map((o, i) => `${String.fromCharCode(65 + i)}, ${o}`).join("; ");
    optionsSuffix = bt(isZh, SPOKEN.optionsList(labels));
  }
  return bt(isZh, SPOKEN.returnTo.normal(qNum, question.text, optionsSuffix));
}

function buildWrapUpSayHello(isZh: boolean): string {
  return bt(isZh, SPOKEN.wrapUp);
}

function buildFarewellSayHello(isZh: boolean): string {
  return bt(isZh, SPOKEN.farewell);
}

async function summarizeQuestion(
  questionText: string,
  transcript: TranscriptEntry[],
  isZh: boolean,
  llmRoute?: RelayLlmRoute,
): Promise<string> {
  if (transcript.length === 0) return "";

  const t = transcript
    .map((m) => `${m.role === "user" ? "Participant" : "Interviewer"}: ${m.text}`)
    .join("\n");

  try {
    const result = await callRelayLLM(bt(isZh, PROMPTS.summarize(questionText, t)), undefined, {
      stage: "q-summary",
    }, llmRoute);
    log.info(`Q summary: "${result.slice(0, 100)}..."`);
    return result;
  } catch (err) {
    log.error("LLM summarization failed:", err);
    return bt(isZh, PROMPTS.summaryError);
  }
}

// ── Relay server ────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: RELAY_PORT });
log.info(`ASR: resource=${ASR_RESOURCE_ID}, auth=${ASR_API_KEY ? `X-Api-Key(${ASR_API_KEY.slice(0, 8)}...)` : "AppKey+AccessKey"}`);
log.info(`ASR VAD: end_window_size=${ASR_END_WINDOW_MS}ms, force_to_speech=${ASR_FORCE_SPEECH_MS}ms`);
log.info(`ASR final coalescing: normal=${ASR_FINAL_COALESCE_MS}ms, long=${ASR_LONG_FINAL_COALESCE_MS}ms, quiet=${ASR_PENDING_FINAL_QUIET_MS}ms, active_speech_hold=${ASR_ACTIVE_SPEECH_HOLD_MS}ms, max_active_hold=${ASR_MAX_ACTIVE_SPEECH_HOLD_MS}ms, session_max_speech=${ASR_SESSION_MAX_CONTINUOUS_SPEECH_MS}ms, stuck_rotate=${ASR_STUCK_TEXT_ROTATE_MS}ms`);
const ttsAuthResolved = getTtsAuth();
log.info(`TTS: resource=${ttsAuthResolved.resourceId}, auth=${ttsAuthResolved.apiKey ? `X-Api-Key(${ttsAuthResolved.apiKey.slice(0, 8)}...)` : "AppId+AccessKey"}`);
if (VISION_LLM_API_KEY) {
  log.info(
    `Vision LLM: ${VISION_LLM_MODEL}${VISION_LLM_RETRY_MODEL !== VISION_LLM_MODEL ? ` (retry: ${VISION_LLM_RETRY_MODEL})` : ""}, max_tokens=${VISION_LLM_MAX_TOKENS}`,
  );
}
logRelayLlmStartup();
log.info(`Listening on ws://localhost:${RELAY_PORT}`);

// 方案B(2026-09-03):ASR 并发连接配额有限(生产实测约 20 路)。20 路同场
// 切题时各会话独立断开/重连,新旧连接短暂叠加会瞬时冲破配额,被拒的会话
// 卡在重连循环。全局串行化所有 connectAsr 并强制最小间隔,消除叠加窗口。
let asrConnectChain: Promise<void> = Promise.resolve();
let asrLastConnectAt = 0;
const ASR_CONNECT_MIN_INTERVAL_MS = 1500;
function scheduleAsrConnect(task: () => Promise<void>): Promise<void> {
  const run = async () => {
    const waitMs = asrLastConnectAt + ASR_CONNECT_MIN_INTERVAL_MS - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    asrLastConnectAt = Date.now();
    await task();
  };
  asrConnectChain = asrConnectChain.then(run, run);
  return asrConnectChain;
}

wss.on("connection", (browserWs) => {
  log.info("Browser connected, waiting for init...");

  const keepBrowserAlive = setInterval(() => {
    if (browserWs.readyState === WebSocket.OPEN) browserWs.ping();
  }, 20000);
  browserWs.on("close", () => clearInterval(keepBrowserAlive));

  const timeout = setTimeout(() => {
    log.error("No init message received within 10s");
    browserWs.close();
  }, 10000);

  const handler = (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "mic_test") {
        clearTimeout(timeout);
        browserWs.removeListener("message", handler);
        handleMicTestConnection(browserWs);
      } else if (msg.type === "init" && msg.context) {
        clearTimeout(timeout);
        browserWs.removeListener("message", handler);
        const context = msg.context as InterviewContext;
        void loadInterviewRelayLlmRoute(dynamicQuestionClient, context.interviewId)
          .then(async (llmRoute) => {
            await assertRelayLlmReady({ route: llmRoute });
            if (browserWs.readyState !== WebSocket.OPEN) return;
            // 终态会话(COMPLETED/ABANDONED)拒绝重新 init:不能因为刷新或
            // interview_incomplete 后的自动重连,从 Q1 重播一场已结束的面试。
            if (await rejectInitForTerminalSession(browserWs, context)) return;
            await handleBrowserConnection(browserWs, context, llmRoute);
          })
          .catch((error) => {
            log.error(
              "Relay LLM unavailable before interview start:",
              error instanceof Error ? error.message : String(error),
            );
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({
                type: "error",
                message: "面试服务暂时不可用，请稍后刷新重试。",
              }));
              browserWs.close(1013, "relay_llm_unavailable");
            }
          });
      }
    } catch {
      // Not JSON, ignore
    }
  };
  browserWs.on("message", handler);
});

// ── 服务端会话收尾(王总 2026-08-21:聊完/关页/后台挂着,计时不能失控) ──
// 此前完成落库全靠前端调 /api/session/complete;浏览器一关或页面在后台
// 挂着,会话就 IN_PROGRESS 无限"活跃"(实测出现过 77 分钟)。relay 在服务
// 端兜底:告别说完即落库 COMPLETED、断线宽限后 ABANDONED、超硬限强制结束。
// 判定逻辑在 ./session-finalization(独立模块可单测)。

const SESSION_DISCONNECT_GRACE_MS =
  Number(process.env.SESSION_DISCONNECT_GRACE_MS) || 10 * 60_000;

const liveSessions = new Map<string, LiveSessionRecord>();
const browserSessionConnections = new SessionConnectionRegistry<WebSocket>();

async function persistSessionStatus(
  sessionId: string,
  status: string,
  reason: string,
): Promise<void> {
  if (!dynamicQuestionClient) {
    log.warn(`session persist skipped (${sessionId} -> ${status} ${reason}): no service client`);
    return;
  }
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status,
    lastActivityAt: nowIso,
    updatedAt: nowIso,
  };
  if (status === "COMPLETED") patch.completedAt = nowIso;
  // 终态写入门:先取当前状态裁决(纯函数可单测),再带旧状态条件更新。
  // 已终态(COMPLETED/ABANDONED)的会话不得被重复放弃/迟到完成/重连清扫改写。
  const { data: currentRow, error: readError } = await dynamicQuestionClient
    .from("sessions")
    .select("status")
    .eq("id", sessionId)
    .maybeSingle();
  if (readError) {
    log.error(`session persist status read failed (${sessionId}): ${readError.message}`);
    return;
  }
  const currentStatus = currentRow?.status as string | null | undefined;
  if (!shouldPersistSessionStatus(status, currentStatus)) {
    log.info(`Session ${sessionId} finalize ${status} skipped (current=${currentStatus ?? "unknown"})`);
    return;
  }
  const { error } = await dynamicQuestionClient
    .from("sessions")
    .update(patch)
    .eq("id", sessionId)
    .neq("status", "COMPLETED")
    .neq("status", "ABANDONED")
    .select("id");
  if (error) {
    log.error(`session persist failed (${sessionId} -> ${status}):`, error.message);
    return;
  }
  log.info(`Session ${sessionId} -> ${status} (${reason})`);
}

async function rejectInitForTerminalSession(
  browserWs: WebSocket,
  ctx: InterviewContext,
): Promise<boolean> {
  const sessionId = typeof ctx.sessionId === "string" ? ctx.sessionId : "";
  if (!sessionId) return false;
  const locallyEnded = liveSessions.get(sessionId)?.status === "ended";
  if (locallyEnded) {
    log.info(`Relay init refused: session ${sessionId} ended in this relay instance`);
    sendTerminalRejection(browserWs);
    return true;
  }
  if (!dynamicQuestionClient) return false;
  const { data, error } = await dynamicQuestionClient
    .from("sessions")
    .select("status")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) {
    log.warn(`Relay init session status read failed (${sessionId}): ${error.message}`);
    // 读不到状态不阻断 init(保持既有行为),终态写入仍有 CAS 兜底。
    return false;
  }
  if (data && isTerminalSessionStatus(data.status as string)) {
    log.info(`Relay init refused: session ${sessionId} is already ${data.status}`);
    sendTerminalRejection(browserWs);
    return true;
  }
  return false;
}

function sendTerminalRejection(browserWs: WebSocket): void {
  if (browserWs.readyState !== WebSocket.OPEN) return;
  browserWs.send(JSON.stringify({
    type: "interview_incomplete",
    reason: "session_terminal",
    message: "该场面试已结束，请查看结果或联系招聘负责人重新安排。",
  }));
  browserWs.close(1013, "session_terminal");
}

function registerLiveSession(ctx: InterviewContext): void {
  const sessionId = typeof ctx.sessionId === "string" ? ctx.sessionId : "";
  if (!sessionId) return;
  const nowMs = Date.now();
  // 同一中继进程已判定终态(abandonForInactivity/收尾落库)的会话不得被
  // 重连复活:否则断线宽限定时器会对已终态会话再写一次 ABANDONED,并让
  // init 重播开场词。真正合法的短断线记录仍是 "live",不受影响。
  const previous = liveSessions.get(sessionId);
  const wasEnded = Boolean(previous && previous.status === "ended");
  liveSessions.set(sessionId, {
    sessionId,
    startedAtMs: nowMs,
    lastActiveAtMs: nowMs,
    timeLimitMinutes:
      typeof ctx.timeLimitMinutes === "number" && ctx.timeLimitMinutes > 0
        ? ctx.timeLimitMinutes
        : null,
    isRecruitmentInterview: ctx.title.includes("数君招聘"),
    status: wasEnded ? "ended" : "live",
  });
  if (dynamicQuestionClient) {
    dynamicQuestionClient
      .from("sessions")
      .select("startedAt")
      .eq("id", sessionId)
      .maybeSingle()
      .then(({ data }) => {
        const record = liveSessions.get(sessionId);
        if (!record || record.status === "ended") return;
        const startedMs = data?.startedAt ? new Date(data.startedAt as string).getTime() : 0;
        if (startedMs > 0 && startedMs < record.startedAtMs) {
          record.startedAtMs = startedMs;
        }
      }, () => undefined);
  }
}

setInterval(() => {
  const nowMs = Date.now();
  liveSessions.forEach((record, sessionId) => {
    const plan = planSessionFinalization(record, nowMs, SESSION_DISCONNECT_GRACE_MS);
    if (!plan) return;
    record.status = "ended";
    void persistSessionStatus(sessionId, plan.status, plan.reason);
  });
}, 60_000).unref();

// ── Mic test handler (ASR-only, no LLM/TTS) ────────────────────────

async function handleMicTestConnection(browserWs: WebSocket) {
  log.info("Mic test mode");

  let asrWs: WebSocket | null = null;
  let asrAlive = false;
  let asrAudioSeq = 1;
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  let asrAccumulator = "";
  let intentionalClose = false;
  let asrReconnecting = false;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 2;

  const autoTimeout = setTimeout(() => {
    log.info("Mic test auto-timeout");
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "timeout" }));
    }
    cleanup();
  }, 10 * 60 * 1000);

  function cleanup() {
    intentionalClose = true;
    clearTimeout(autoTimeout);
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (asrAlive && asrWs && asrWs.readyState === WebSocket.OPEN) {
      try {
        asrAudioSeq++;
        asrWs.send(buildBigModelAudioRequest(Buffer.alloc(0), asrAudioSeq, true));
      } catch { /* ignore */ }
    }
    asrWs?.removeAllListeners();
    asrWs?.close();
    asrWs = null;
    asrAlive = false;
  }

  function startKeepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(() => {
      if (!asrAlive || !asrWs || asrWs.readyState !== WebSocket.OPEN) return;
      try {
        asrAudioSeq++;
        asrWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), asrAudioSeq));
      } catch (err) {
        void recoverMicTestAsr(`keep-alive failed: ${String(err)}`);
      }
    }, 5000);
  }

  async function recoverMicTestAsr(reason: string) {
    if (intentionalClose || browserWs.readyState !== WebSocket.OPEN || asrReconnecting) return;
    asrReconnecting = true;
    asrAlive = false;
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    const failedWs = asrWs;
    asrWs = null;
    failedWs?.removeAllListeners();
    try { failedWs?.close(); } catch { /* ignore */ }

    while (!intentionalClose && browserWs.readyState === WebSocket.OPEN
        && reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts += 1;
      log.warn(`Mic test ASR recovery ${reconnectAttempts}/${maxReconnectAttempts}: ${reason}`);
      await new Promise((resolve) => setTimeout(resolve, reconnectAttempts * 500));
      if (intentionalClose || browserWs.readyState !== WebSocket.OPEN) break;
      try {
        await connectMicTestAsr(false);
        startKeepAlive();
        asrReconnecting = false;
        return;
      } catch (err) {
        reason = `reconnect failed: ${String(err)}`;
      }
    }

    asrReconnecting = false;
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "disconnected", reason: "asr_unavailable" }));
      browserWs.close();
    }
    cleanup();
  }

  function bindAsrMessageHandlers(ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      try {
        const resp = parseAsrResponse(Buffer.from(data));

        if (resp.errorCode != null) {
          log.error(`Mic test ASR error: ${resp.errorCode} ${resp.errorMessage}`);
          void recoverMicTestAsr(`provider error ${resp.errorCode}`);
          return;
        }

        if (resp.utterances) {
        reconnectAttempts = 0;
          for (const utt of resp.utterances) {
            if (utt.text) {
              asrAccumulator = utt.text;
              if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({
                  type: "asr",
                  data: { results: [{ text: utt.text, definite: utt.definite }] },
                }));
              }
              if (utt.definite) {
                if (browserWs.readyState === WebSocket.OPEN) {
                  browserWs.send(JSON.stringify({ type: "asr_ended", text: asrAccumulator.trim() }));
                }
                asrAccumulator = "";
              }
            }
          }
        } else if (resp.text) {
          asrAccumulator = resp.text;
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({
              type: "asr",
              data: { results: [{ text: resp.text, definite: resp.isLastPackage }] },
            }));
          }
          if (resp.isLastPackage) {
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "asr_ended", text: asrAccumulator.trim() }));
            }
            asrAccumulator = "";
          }
        }
      } catch (err) {
        log.error("Mic test ASR parse error:", err);
      }
    });

    ws.on("error", (err: Error) => {
      log.error("Mic test ASR error:", err.message);
      void recoverMicTestAsr(err.message);
    });

    ws.on("close", () => {
      asrAlive = false;
      asrWs = null;
      if (intentionalClose || browserWs.readyState !== WebSocket.OPEN || asrReconnecting) {
        return;
      }
      log.info("Mic test ASR closed — reconnecting for continuous transcription");
      void recoverMicTestAsr("provider socket closed");
    });
  }

  async function connectMicTestAsr(isInitial: boolean): Promise<void> {
    if (asrWs) {
      asrWs.removeAllListeners();
      try {
        asrWs.close();
      } catch { /* ignore */ }
      asrWs = null;
      asrAlive = false;
    }

    const reqid = randomUUID().replace(/-/g, "");
    const asrConfig: BigModelAsrConfig = {
      format: "pcm", rate: 16000, bits: 16, channels: 1, codec: "raw",
      showUtterance: true, resultType: "full", enablePunc: true,
      endWindowSize: ASR_END_WINDOW_MS,
      forceToSpeechTime: ASR_FORCE_SPEECH_MS,
    };

    const wsHeaders = buildBigModelHeaders(
      ASR_APP_ID, ASR_ACCESS_TOKEN, reqid, ASR_RESOURCE_ID,
      ASR_API_KEY || undefined,
    );
    const nextWs = new WebSocket(BIGMODEL_ASR_URL, { headers: wsHeaders });

    try {
      await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ASR connect timeout")), 10000);
      nextWs.on("open", () => { clearTimeout(t); resolve(); });
      nextWs.on("error", (e) => { clearTimeout(t); reject(e); });
      nextWs.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          clearTimeout(t);
          log.error(`Mic test ASR rejected: HTTP ${res.statusCode} — ${body}`);
          reject(new Error(`ASR server responded ${res.statusCode}: ${body}`));
        });
      });
      });
    } catch (error) {
      nextWs.removeAllListeners();
      try { nextWs.close(); } catch { /* ignore */ }
      throw error;
    }

    asrWs = nextWs;
    asrWs.send(buildBigModelFullRequest(asrConfig, reqid));
    asrAlive = true;
    bindAsrMessageHandlers(asrWs);
    log.info(`Mic test ASR connected${isInitial ? "" : " (reconnected)"}`);

    if (isInitial && browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "ready" }));
    }
  }

  browserWs.on("message", (data) => {
    if (!asrWs || asrWs.readyState !== WebSocket.OPEN || !asrAlive) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "audio" && msg.data) {
        asrAudioSeq++;
        asrWs.send(buildBigModelAudioRequest(Buffer.from(msg.data, "hex"), asrAudioSeq));
      }
    } catch { /* ignore */ }
  });

  browserWs.on("close", () => {
    log.info("Mic test: browser disconnected");
    cleanup();
  });

  try {
    await connectMicTestAsr(true);
    startKeepAlive();
  } catch (err) {
    log.error("Mic test connection failed:", err);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({
        type: "error",
        message: `Mic test failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
    browserWs.close();
    cleanup();
  }
}

// ── Interview handler ───────────────────────────────────────────────

async function handleBrowserConnection(
  browserWs: WebSocket,
  ctx: InterviewContext,
  llmRoute?: RelayLlmRoute,
) {
  // ── 服务端收尾登记:本连接活跃时持续摸时间,关页后由宽限/硬限兜底 ──
  const ctxSessionId = typeof ctx.sessionId === "string" ? ctx.sessionId : "";
  const connectionClaim = ctxSessionId
    ? browserSessionConnections.claim(ctxSessionId, browserWs)
    : null;
  const ownsPersistedSession = () =>
    !ctxSessionId
    || !connectionClaim
    || browserSessionConnections.isCurrent(ctxSessionId, connectionClaim.lease);
  if (connectionClaim?.superseded) {
    log.info("New browser connection superseded the previous relay for this session");
  }
  registerLiveSession(ctx);
  browserWs.on("message", () => {
    if (!ownsPersistedSession()) return;
    const record = ctxSessionId ? liveSessions.get(ctxSessionId) : undefined;
    if (record && record.status === "live") record.lastActiveAtMs = Date.now();
  });

  // ── ASR state ──────────────────────────────────────────────────
  let asrWs: WebSocket | null = null;
  let asrAlive = false;
  let asrAudioSeq = 1;
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  // ── TTS state ──────────────────────────────────────────────────
  let ttsAbortController: AbortController | null = null;
  let ttsSpeaking = false;

  // When true, definite ASR results are dropped (only used for barge-in).
  // Set during LLM generation + TTS playback to prevent echo loops.
  // Cleared after barge-in or when the response cycle finishes.
  let suppressAsrResults = false;
  /** Definite user text captured while suppressAsrResults (flushed after reopenAsr). */
  let pendingUserUtteranceWhileSuppressed = "";
  /** User final arrived while handleUserUtterance was already running (asr_ended already sent to client). */
  let queuedUserUtteranceWhileGenerating = "";
  let queuedUserUtteranceIsChat = false;

  // ── Per-question state ──────────────────────────────────────────
  let currentQuestionIndex = 0;
  const questionSummaries: string[] = [];
  let questionTranscript: TranscriptEntry[] = [];
  let asrAccumulator = "";
  let pendingAsrFinalText = "";
  let pendingAsrFinalTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAsrFinalStartedAt = 0;
  let pendingAsrFinalLastChangedAt = 0;
  let lastUserAudioActivityAt = 0;
  let asrSessionFirstSpeechAt = 0;
  let lastAsrStuckRotationAt = 0;
  let consecutiveDuplicateSkips = 0;
  let heldBargeInInterimText = "";
  let heldBargeInInterimTimer: ReturnType<typeof setTimeout> | null = null;
  let isTransitioning = false;
  let transitionGeneration = 0;
  let pendingManualTransitionDirection: "next" | "previous" | null = null;
  let interviewDone = false;
  /** endInterview 已执行(告别播完/收尾信号已发):断线时据此判断要不要落库完成 */
  let farewellCompleted = false;
  /** True as soon as we start farewell shutdown; blocks duplicate ASR finals until interviewDone. */
  let endingInterview = false;

  // ── Agent context state ────────────────────────────────────────
  let currentCodeContent = "";
  let currentCodeLanguage = "plaintext";
  let latestWhiteboardImage = "";
  let whiteboardDirty = false;
  let cachedWhiteboardDescription = "";
  let lastResponseWasCorrection = false;
  const recentAgentResponses: string[] = [];
  let pendingWhiteboardVision = false;
  const pendingWhiteboardSnapshotRequests = new Map<string, (hasImage: boolean) => void>();

  // ── Final-response state ──────────────────────────────────────
  let awaitingFinalResponse = false;
  let finalResponseTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingLastQuestionTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── LLM-controlled response state ─────────────────────────────
  let generatingResponse = false;
  let userTurnsOnCurrentQ = 0;
  const isOprunRecruitmentInterview = ctx.title.includes("数君招聘");
  // Recruitment interviews may use up to three concise verification follow-ups:
  // Q2-Q7 share up to two in-place checks and Q8 may use one optional final
  // cross-question verification. No individual scored question may receive
  // more than one follow-up; Q1 and candidate closing do not expose one.
  let totalFollowUpsUsed = 0;
  let recruitmentInlineFollowUpsUsed = 0;
  let recruitmentFinalFollowUpsUsed = 0;
  let recruitmentParticipantMetadata: unknown = null;
  let recruitmentParticipantMetadataLoaded = false;
  // Preserve the upstream 15-turn allowance for non-recruitment interviews;
  // OpRun recruitment uses the stricter evidence-verification budget below.
  const GLOBAL_FOLLOW_UP_LIMIT = 15;
  const OPRUN_RECRUITMENT_FOLLOW_UP_LIMIT = 3;
  const RECRUITMENT_INLINE_FOLLOW_UP_LIMIT = 2;
  const RECRUITMENT_FINAL_FOLLOW_UP_LIMIT = 1;
  // 候选人静默处理(王总 2026-08-21):不再"静默即切题"——
  // 静默先问"答完了吗?",开口即留在本题;确认后再切题;
  // 连续多题零回答(AFK/人已离开)提前诚实收尾,不空转不烧算力。
  // 2026-09-03 王总拍板:首问从 45s 提前到 30s(env SILENCE_ASK_SECONDS 可覆盖)。
  let silenceAutoSkipTimer: ReturnType<typeof setTimeout> | null = null;
  const SILENCE_ASK_MS = Math.max(
    10_000,
    (Number(process.env.SILENCE_ASK_SECONDS) || 30) * 1000,
  );
  const SILENCE_CONFIRM_MS = Math.max(
    5_000,
    (Number(process.env.SILENCE_CONFIRM_SECONDS) || 20) * 1000,
  );
  const MAX_SILENT_ASKS_PER_QUESTION = 2;
  const MAX_UNANSWERED_QUESTIONS_STREAK = 2;
  let silenceAskCount = 0;
  let silenceConfirmPending = false;
  let unansweredQuestionsStreak = 0;
  /** Wall time when the latest assistant line was appended to questionTranscript (split-noise heuristic). */
  let lastAssistantMessageWallClockMs = 0;
  const recentAcceptedUserFinals: RecentAsrFinal[] = [];

  function rememberAcceptedUserFinal(text: string) {
    const finalText = text.replace(/\s+/g, " ").trim();
    if (!finalText) return;

    const last = recentAcceptedUserFinals[recentAcceptedUserFinals.length - 1];
    if (last && shouldSuppressAnsweredAsrFinal(last.text, finalText)) {
      last.text = mergeAsrSegments(last.text, finalText);
      last.at = Date.now();
      return;
    }

    recentAcceptedUserFinals.push({ text: finalText, at: Date.now() });
    while (recentAcceptedUserFinals.length > 8) recentAcceptedUserFinals.shift();
  }

  function shouldSuppressRecentUserFinalReplay(text: string): boolean {
    const currentQuestionAlreadyHasUser = questionTranscript.some((entry) => entry.role === "user");
    if (currentQuestionAlreadyHasUser && !generatingResponse && !suppressAsrResults && !isTransitioning) {
      return false;
    }

    return shouldSuppressRecentAsrFinal(
      text,
      recentAcceptedUserFinals,
      Date.now(),
      {
        ttlMs: ASR_RECENT_FINAL_REPLAY_TTL_MS,
        minComparisonUnits: ASR_RECENT_FINAL_REPLAY_MIN_UNITS,
      },
    );
  }

  function settleWhiteboardSnapshotRequest(requestId: string, hasImage: boolean) {
    const resolve = pendingWhiteboardSnapshotRequests.get(requestId);
    if (!resolve) return;
    pendingWhiteboardSnapshotRequests.delete(requestId);
    resolve(hasImage);
  }

  function settleAllWhiteboardSnapshotRequests(hasImage: boolean) {
    for (const [requestId, resolve] of Array.from(pendingWhiteboardSnapshotRequests.entries())) {
      pendingWhiteboardSnapshotRequests.delete(requestId);
      resolve(hasImage);
    }
  }

  async function requestFreshWhiteboardSnapshot(reason: string): Promise<boolean> {
    if (browserWs.readyState !== WebSocket.OPEN) return false;

    const requestId = randomUUID();
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingWhiteboardSnapshotRequests.delete(requestId);
        log.warn(`Whiteboard snapshot request timed out (${reason})`);
        resolve(false);
      }, WHITEBOARD_SNAPSHOT_REQUEST_TIMEOUT_MS);

      pendingWhiteboardSnapshotRequests.set(requestId, (hasImage) => {
        clearTimeout(timer);
        resolve(hasImage);
      });

      browserWs.send(JSON.stringify({
        type: "whiteboard_snapshot_request",
        requestId,
        reason,
      }));
    });
  }

  let sortedQuestions = [...ctx.questions].sort((a, b) => a.order - b.order);
  let questionRefreshInFlight = false;
  let pendingProgressiveTransition = false;

  function normalizeDynamicQuestions(rows: unknown): typeof sortedQuestions {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        text: String(item.text || ""),
        type: String(item.type || "OPEN_ENDED"),
        description: typeof item.description === "string" ? item.description : null,
        options: item.options as { options: string[]; allowMultiple?: boolean } | null,
        timeLimitSeconds:
          typeof item.timeLimitSeconds === "number" ? item.timeLimitSeconds : null,
        order: Number(item.order || 0),
      };
    }).filter((row) => row.text);
  }

  function applyDynamicQuestionSet(rows: unknown, source: "database" | "browser"): boolean {
    const incoming = normalizeDynamicQuestions(rows);
    const merged = mergeExpandedQuestionSet(
      sortedQuestions,
      incoming,
      currentQuestionIndex,
    );
    if (!merged) {
      if (incoming.length > sortedQuestions.length) {
        log.warn(`Rejected ${source} question refresh that changed an active question`);
      }
      return false;
    }
    sortedQuestions = merged;
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({
        type: "question_count_update",
        totalQuestions: sortedQuestions.length,
      }));
    }
    log.info(`Dynamic questions refreshed from ${source}: total=${sortedQuestions.length}`);
    if (
      pendingProgressiveTransition
      && !isProgressiveOpeningOnly(sortedQuestions)
      && currentQuestionIndex < sortedQuestions.length - 1
    ) {
      pendingProgressiveTransition = false;
      setTimeout(() => {
        if (!isTransitioning && !interviewDone) {
          handleTransition(true).catch(log.error);
        }
      }, 0);
    }
    return true;
  }

  async function refreshDynamicQuestions(): Promise<boolean> {
    if (!ctx.interviewId || !dynamicQuestionClient || questionRefreshInFlight) {
      return false;
    }
    questionRefreshInFlight = true;
    try {
      const { data, error } = await dynamicQuestionClient
        .from("questions")
        .select("text,type,description,options,timeLimitSeconds,order")
        .eq("interviewId", ctx.interviewId)
        .order("order", { ascending: true });
      if (error) {
        log.warn(`Dynamic question refresh failed: ${error.message}`);
        return false;
      }
      return applyDynamicQuestionSet(data ?? [], "database");
    } finally {
      questionRefreshInFlight = false;
    }
  }
  const dynamicQuestionTimer = ctx.interviewId
    ? setInterval(() => { refreshDynamicQuestions().catch(log.error); }, 2_000)
    : null;
  const configIsZh = isChineseInterview(ctx);
  let isZh = configIsZh;

  const userLangSamples: string[] = [];
  function updateUserLanguage(text: string) {
    if (!text || text.length < 3) return;
    userLangSamples.push(text);
    if (userLangSamples.length > 5) userLangSamples.shift();

    const combined = userLangSamples.join(" ");
    const cjkChars = (combined.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const totalChars = combined.replace(/\s+/g, "").length;
    if (totalChars === 0) return;

    const cjkRatio = cjkChars / totalChars;
    const detectedZh = cjkRatio > 0.3;
    if (detectedZh !== isZh) {
      isZh = detectedZh;
      log.info(`User language detected: ${detectedZh ? "zh" : "en"} (CJK ratio: ${(cjkRatio * 100).toFixed(0)}%, overriding config=${configIsZh ? "zh" : "en"})`);
    }
  }

  const startIdx = ctx.startQuestionIndex ?? 0;
  if (startIdx > 0 && startIdx < sortedQuestions.length) {
    currentQuestionIndex = startIdx;
  }

  async function persistRecruitmentFollowUpBudget(): Promise<boolean> {
    if (
      !isOprunRecruitmentInterview
      || !ctx.sessionId
      || !dynamicQuestionClient
      || !recruitmentParticipantMetadataLoaded
    ) {
      return false;
    }
    const nextMetadata = mergePersistedRecruitmentFollowUpBudget(
      recruitmentParticipantMetadata,
      {
        inlineFollowUpsUsed: recruitmentInlineFollowUpsUsed,
        finalFollowUpsUsed: recruitmentFinalFollowUpsUsed,
      },
    );
    const { error } = await dynamicQuestionClient
      .from("sessions")
      .update({ participantMetadata: nextMetadata })
      .eq("id", ctx.sessionId);
    if (error) {
      log.error(`Recruitment follow-up budget persistence failed: ${error.message}`);
      return false;
    }
    recruitmentParticipantMetadata = nextMetadata;
    return true;
  }

  async function hydrateRecruitmentResumeBudget() {
    if (!isOprunRecruitmentInterview) return;
    const applyFailClosedBudget = (reason: string) => {
      const fallback = failClosedRecruitmentResumeBudget(currentQuestionIndex);
      recruitmentInlineFollowUpsUsed = fallback.inlineFollowUpsUsed;
      recruitmentFinalFollowUpsUsed = fallback.finalFollowUpsUsed;
      totalFollowUpsUsed = recruitmentInlineFollowUpsUsed + recruitmentFinalFollowUpsUsed;
      log.warn(
        `Recruitment resume budget hydration unavailable (${reason}); `
        + `fail-closed inline=${recruitmentInlineFollowUpsUsed}/2 `
        + `final=${recruitmentFinalFollowUpsUsed}/1`,
      );
    };
    if (!ctx.sessionId || !dynamicQuestionClient) {
      applyFailClosedBudget(!ctx.sessionId ? "missing session id" : "missing database client");
      return;
    }
    const { data: sessionData, error: sessionError } = await dynamicQuestionClient
      .from("sessions")
      .select("participantMetadata")
      .eq("id", ctx.sessionId)
      .single();
    if (!sessionError) {
      recruitmentParticipantMetadata = sessionData?.participantMetadata ?? null;
      recruitmentParticipantMetadataLoaded = true;
    } else {
      log.warn(`Recruitment follow-up metadata hydration failed: ${sessionError.message}`);
    }
    const persistedBudget = readPersistedRecruitmentFollowUpBudget(
      recruitmentParticipantMetadata,
    );
    const { data, error } = await dynamicQuestionClient
      .from("messages")
      .select("role,questionId,content,timestamp")
      .eq("sessionId", ctx.sessionId)
      .order("timestamp", { ascending: true });
    if (error && !persistedBudget) {
      applyFailClosedBudget(`database error: ${error.message}`);
      return;
    }

    const summary = summarizeRecruitmentResumeBudget(
      sortedQuestions.map((question) => question.id),
      data ?? [],
    );
    recruitmentInlineFollowUpsUsed = Math.max(
      summary.inlineFollowUpsUsed,
      persistedBudget?.inlineFollowUpsUsed ?? 0,
    );
    recruitmentFinalFollowUpsUsed = Math.max(
      summary.finalFollowUpsUsed,
      persistedBudget?.finalFollowUpsUsed ?? 0,
    );
    totalFollowUpsUsed = recruitmentInlineFollowUpsUsed + recruitmentFinalFollowUpsUsed;
    userTurnsOnCurrentQ = new Map(summary.answersByQuestion).get(currentQuestionIndex) || 0;
    log.info(
      `Hydrated recruitment resume budget: inline=${recruitmentInlineFollowUpsUsed}/2 `
      + `final=${recruitmentFinalFollowUpsUsed}/1 current_turns=${userTurnsOnCurrentQ}`,
    );
    if (
      !persistedBudget
      || persistedBudget.inlineFollowUpsUsed < recruitmentInlineFollowUpsUsed
      || persistedBudget.finalFollowUpsUsed < recruitmentFinalFollowUpsUsed
    ) {
      await persistRecruitmentFollowUpBudget();
    }
  }

  await hydrateRecruitmentResumeBudget();

  let maxFollowUps: number;
  switch (ctx.followUpDepth) {
    case "LIGHT":   maxFollowUps = 2; break;
    case "MODERATE": maxFollowUps = 7; break;
    case "DEEP":    maxFollowUps = 12; break;
    default:        maxFollowUps = 2;
  }
  // 招聘一面按证据式面试至少给到 MODERATE 深度（每题 7 次追问），
  // 由全局上限与面试时长兜底，避免 LIGHT 档把深挖掐死。
  if (/^数君招聘\s*·\s*/.test(ctx.title) && maxFollowUps < 7) {
    maxFollowUps = 7;
  }

  log.info(
    `Interview: "${ctx.title}" (${sortedQuestions.length} questions, lang=${ctx.language}, startQ=${currentQuestionIndex})`
  );

  const NEXT_TOKEN = "[NEXT]";
  const PREV_TOKEN = "[PREV]";

  function clearPendingAsrFinal() {
    if (pendingAsrFinalTimer) {
      clearTimeout(pendingAsrFinalTimer);
      pendingAsrFinalTimer = null;
    }
    pendingAsrFinalText = "";
    pendingAsrFinalStartedAt = 0;
    pendingAsrFinalLastChangedAt = 0;
  }

  function clearHeldBargeInInterim() {
    if (heldBargeInInterimTimer) {
      clearTimeout(heldBargeInInterimTimer);
      heldBargeInInterimTimer = null;
    }
    heldBargeInInterimText = "";
  }

  function getAsrFinalCoalesceDelay(text: string): number {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const terminalPunctuation = /[.?!。？！]\s*$/.test(text);
    const looksShortAndComplete =
      wordCount <= 9 &&
      terminalPunctuation &&
      (/[?？]\s*$/.test(text) || /\b(?:yes|yeah|yep|no|okay|ok|hello|hi)\b/i.test(text));

    if (looksShortAndComplete) return ASR_SHORT_FINAL_COALESCE_MS;
    if (wordCount >= 18 || text.length >= 120) return ASR_LONG_FINAL_COALESCE_MS;
    return ASR_FINAL_COALESCE_MS;
  }

  function noteIncomingAudioActivity(pcm: Buffer) {
    if (pcm.length < 2) return;

    let sumSq = 0;
    let samples = 0;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset) / 32768;
      sumSq += sample * sample;
      samples++;
    }
    if (samples === 0) return;

    const rms = Math.sqrt(sumSq / samples);
    if (rms >= ASR_AUDIO_ACTIVITY_RMS_THRESHOLD) {
      lastUserAudioActivityAt = Date.now();
    }
  }

  function shouldHoldPendingAsrFinalForActiveSpeech(finalText: string): boolean {
    if (!finalText || ASR_ACTIVE_SPEECH_HOLD_MS <= 0) return false;
    // 王总 2026-09-03：删除"短句(<12词/80字)不受保护"的豁免——答题开头的短段
    // 停顿后继续讲时最容易被打断；真正答完的人此时麦是静的，不受影响。
    const heldForMs = pendingAsrFinalStartedAt ? Date.now() - pendingAsrFinalStartedAt : 0;
    const recentlyChanged =
      pendingAsrFinalLastChangedAt > 0 &&
      Date.now() - pendingAsrFinalLastChangedAt < ASR_PENDING_FINAL_QUIET_MS;
    const micStillActive = Date.now() - lastUserAudioActivityAt < ASR_ACTIVE_SPEECH_HOLD_MS;
    const holdDecision = decidePendingFinalSpeechHold({
      qualifiesForHold: true,
      heldForMs,
      maxHoldMs: ASR_MAX_ACTIVE_SPEECH_HOLD_MS,
      recentlyChanged,
      micStillActive,
    });
    if (holdDecision.hardCapExceeded) {
      log.warn(
        `ASR active-speech hold exceeded ${ASR_MAX_ACTIVE_SPEECH_HOLD_MS}ms; committing pending final`,
      );
      return false;
    }
    if (!holdDecision.hold) return false;

    const textStuckMs =
      pendingAsrFinalLastChangedAt > 0
        ? Date.now() - pendingAsrFinalLastChangedAt
        : 0;
    const sinceLastStuckRotation = lastAsrStuckRotationAt > 0
      ? Date.now() - lastAsrStuckRotationAt
      : Infinity;
    if (
      ASR_STUCK_TEXT_ROTATE_MS > 0 &&
      textStuckMs >= ASR_STUCK_TEXT_ROTATE_MS &&
      sinceLastStuckRotation >= ASR_STUCK_TEXT_ROTATE_MS
    ) {
      log.warn(
        `ASR text stuck for ${textStuckMs}ms while mic active; rotating ASR session to recover`,
      );
      lastAsrStuckRotationAt = Date.now();
      rotateAsrSession();
      return true;
    }

    if (
      ASR_SESSION_MAX_CONTINUOUS_SPEECH_MS > 0 &&
      asrSessionFirstSpeechAt > 0 &&
      Date.now() - asrSessionFirstSpeechAt > ASR_SESSION_MAX_CONTINUOUS_SPEECH_MS
    ) {
      log.warn(
        `ASR session continuous speech exceeded ${ASR_SESSION_MAX_CONTINUOUS_SPEECH_MS}ms; rotating ASR session (keeping pending text)`,
      );
      rotateAsrSession();
      return true;
    }

    return true;
  }

  /**
   * Disconnect and reconnect the ASR engine WITHOUT clearing pendingAsrFinalText.
   * Prevents mid-sentence cutoff while refreshing a degraded ASR session.
   */
  function rotateAsrSession() {
    asrIntentionalClose = true;
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (asrWs && asrWs.readyState === WebSocket.OPEN && asrAlive) {
      try {
        asrAudioSeq++;
        asrWs.send(buildBigModelAudioRequest(Buffer.alloc(0), asrAudioSeq, true));
      } catch { /* ignore */ }
    }
    if (asrWs) {
      asrWs.removeAllListeners();
      try { asrWs.close(); } catch { /* ignore */ }
    }
    asrWs = null;
    asrAlive = false;
    asrAccumulator = "";
    asrSessionFirstSpeechAt = 0;
    connectAsr().catch(log.error);
  }

  function flushHeldBargeInInterim(reason: string) {
    const rawText = heldBargeInInterimText.trim();
    clearHeldBargeInInterim();

    if (!rawText || rawText.length < 2 || interviewDone || endingInterview || isTransitioning) return;

    let finalText = collapseInternalAsrRepetitions(rawText);

    const lastUserTurn = [...questionTranscript].reverse().find((e) => e.role === "user");
    if (lastUserTurn) {
      finalText = trimCrossTurnOverlap(lastUserTurn.text, finalText);
      if (!finalText.trim()) return;
    }

    // 双保险:无 final 的提升要求 ≥4 字;且与 AI 刚播报内容同源(子串)的
    // 碎片视为回声丢弃,不进入 LLM 回合。
    if (reason === "no-final-after-barge-in" && finalText.length < 4) {
      log.warn(`Barge-in fragment too short (${finalText.length} chars), ignored`);
      return;
    }
    const lastAssistantTurn = [...questionTranscript].reverse().find((e) => e.role === "assistant");
    const stripPunct = (value: string) => value.replace(/[\s,。.!??、;:????]/g, "");
    const fragmentNorm = stripPunct(finalText);
    if (
      lastAssistantTurn &&
      fragmentNorm.length >= 2 &&
      stripPunct(lastAssistantTurn.text).includes(fragmentNorm)
    ) {
      log.warn(`Barge-in fragment echoes assistant speech, ignored: "${finalText.slice(0, 40)}"`);
      return;
    }
    log.info(`ASR barge-in interim promoted (${reason}): "${finalText.slice(0, 80)}"`);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "asr_ended", text: finalText }));
    }
    handleUserUtterance(finalText, { allowRecentReplay: true }).catch(log.error);
  }

  function holdBargeInInterim(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < 2) return;

    heldBargeInInterimText = heldBargeInInterimText
      ? mergeAsrSegments(heldBargeInInterimText, trimmed)
      : trimmed;

    if (heldBargeInInterimTimer) {
      clearTimeout(heldBargeInInterimTimer);
    }
    heldBargeInInterimTimer = setTimeout(() => {
      flushHeldBargeInInterim("no-final-after-barge-in");
    }, ASR_FINAL_COALESCE_MS);
  }

  function sendAsrInterim(text: string) {
    if (browserWs.readyState !== WebSocket.OPEN) return;
    browserWs.send(JSON.stringify({
      type: "asr",
      data: { results: [{ text, definite: false }] },
    }));
  }

  function sendAsrPending(text: string, delayMs: number) {
    if (browserWs.readyState !== WebSocket.OPEN) return;
    browserWs.send(JSON.stringify({
      type: "asr_pending",
      text,
      delayMs,
    }));
  }

  function flushPendingAsrFinal(reason: string) {
    const rawText = pendingAsrFinalText.trim();
    if (!rawText || rawText.length < 2 || interviewDone || endingInterview || isTransitioning) {
      clearPendingAsrFinal();
      return;
    }

    if (shouldHoldPendingAsrFinalForActiveSpeech(rawText)) {
      if (pendingAsrFinalTimer) {
        clearTimeout(pendingAsrFinalTimer);
      }
      pendingAsrFinalTimer = setTimeout(() => {
        flushPendingAsrFinal(`${reason}, active speech guard`);
      }, ASR_ACTIVE_SPEECH_HOLD_MS);
      log.info(
        `ASR final held (${reason}, speech not settled): "${rawText.slice(0, 80)}"`,
      );
      return;
    }

    clearPendingAsrFinal();

    let finalText = collapseInternalAsrRepetitions(rawText);

    const lastUserTurn = [...questionTranscript].reverse().find((e) => e.role === "user");
    if (lastUserTurn) {
      finalText = trimCrossTurnOverlap(lastUserTurn.text, finalText);
      if (!finalText.trim()) return;
    }

    if (
      shouldIgnoreVolcContinuationFragment(
        finalText,
        questionTranscript,
        lastAssistantMessageWallClockMs,
        isZh,
      )
    ) {
      return;
    }

    if (isDuplicateUserFinal(finalText)) {
      consecutiveDuplicateSkips++;
      log.info(`ASR FINAL (${reason}) skipped — duplicate of answered turn: "${finalText.slice(0, 72)}..."`);
      if (consecutiveDuplicateSkips >= 2) {
        log.warn(`ASR stuck: ${consecutiveDuplicateSkips} consecutive duplicate skips — forcing reconnection`);
        consecutiveDuplicateSkips = 0;
        disconnectAsr();
        connectAsr().catch(log.error);
      }
      return;
    }

    consecutiveDuplicateSkips = 0;
    log.info(`ASR FINAL (${reason}): "${finalText.slice(0, 80)}"`);

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "asr_ended", text: finalText }));
    }

    handleUserUtterance(finalText).catch(log.error);
  }

  function schedulePendingAsrFinal(text: string, reason: string) {
    const prev = pendingAsrFinalText;
    const merged = mergeAsrSegments(pendingAsrFinalText, text);
    const unchanged =
      !!prev &&
      normalizeUserUtteranceKey(prev) === normalizeUserUtteranceKey(merged);

    if (unchanged && pendingAsrFinalTimer) {
      log.debug(`ASR duplicate definite while pending: "${merged.slice(0, 80)}"`);
      return;
    }

    pendingAsrFinalText = merged;
    pendingAsrFinalLastChangedAt = Date.now();
    if (!pendingAsrFinalStartedAt) {
      pendingAsrFinalStartedAt = pendingAsrFinalLastChangedAt;
    }
    sendAsrInterim(merged);

    if (pendingAsrFinalTimer) {
      clearTimeout(pendingAsrFinalTimer);
    }
    const targetDelay = getAsrFinalCoalesceDelay(merged);
    const elapsed = Date.now() - pendingAsrFinalStartedAt;
    const quietElapsed = Date.now() - pendingAsrFinalLastChangedAt;
    const delay = Math.max(
      0,
      targetDelay - elapsed,
      ASR_PENDING_FINAL_QUIET_MS - quietElapsed,
    );
    pendingAsrFinalTimer = setTimeout(() => {
      flushPendingAsrFinal("coalesced");
    }, delay);
    sendAsrPending(merged, delay);

    log.info(
      `ASR final pending (${reason}, ${delay}ms): "${merged.slice(0, 80)}"`,
    );
  }

  // ── TTS helpers ────────────────────────────────────────────────

  function cancelTts() {
    if (ttsAbortController) {
      ttsAbortController.abort();
      ttsAbortController = null;
    }
    ttsSpeaking = false;
  }

  /**
   * Speak text via TTS 2.0 API, streaming audio chunks to the browser.
   * Returns true if TTS completed without cancellation.
   */
  async function speakText(text: string): Promise<boolean> {
    cancelTts();

    const abortController = new AbortController();
    ttsAbortController = abortController;
    ttsSpeaking = true;

    const ttsOpts = getTtsOptions(ctx.language);
    const auth = getTtsAuth();

    // Interrupt any residual browser-side playback and notify TTS starting
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "interrupt" }));
    }

    let completed = false;
    let totalAudioBytes = 0;
    const streamStartMs = Date.now();
    let sentTranscriptText = false;
    const sendTranscriptTextOnce = () => {
      if (sentTranscriptText || browserWs.readyState !== WebSocket.OPEN) return;
      sentTranscriptText = true;
      browserWs.send(JSON.stringify({ type: "tts_text", data: { text } }));
    };

    // 单次合成尝试。返回 ok=收到完整 done;audioBytes 用于判断能否安全重试
    // (已推送过音频再重试会导致浏览器端音频重复)。
    const attempt = async (): Promise<{ ok: boolean; audioBytes: number }> => {
      let ok = false;
      let audioBytes = 0;
      try {
        for await (const event of synthesizeSpeech(text, auth, ttsOpts, abortController.signal)) {
          if (abortController.signal.aborted) break;
          if (browserWs.readyState !== WebSocket.OPEN) break;

          if (event.type === "audio" && event.audio) {
            sendTranscriptTextOnce();
            browserWs.send(event.audio, { binary: true });
            audioBytes += event.audio.length;
          } else if (event.type === "sentence_start") {
            // The full response text is sent once the first audio chunk is ready.
          } else if (event.type === "sentence_end") {
            browserWs.send(JSON.stringify({ type: "tts_sentence_end", data: { text: event.text } }));
          } else if (event.type === "error") {
            log.error(`TTS error: ${event.error}`);
            return { ok: false, audioBytes };
          } else if (event.type === "done") {
            ok = true;
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          log.error("TTS streaming error:", err);
        }
        return { ok: false, audioBytes };
      }
      return { ok, audioBytes };
    };

    let result = await attempt();
    if (
      !result.ok && result.audioBytes === 0
      && !abortController.signal.aborted && browserWs.readyState === WebSocket.OPEN
    ) {
      // 生产缺陷(2026-09-02 取证):供应商 TTS 流挂起曾把面试永久冻结。
      // 未推送任何音频时安全重试一次。
      log.warn("TTS attempt 1 failed without audio — retrying once");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!abortController.signal.aborted && browserWs.readyState === WebSocket.OPEN) {
        result = await attempt();
      }
    }
    if (result.ok) {
      completed = true;
      totalAudioBytes = result.audioBytes;
    }

    // 双重失败(且未被抢占)时以纯文本兜底送达:tts_text + tts_ended 让前端
    // 回到可作答状态、题目切换/收尾流程照常走,绝不永久卡死。
    const degradedTextOnly = !completed
      && !abortController.signal.aborted
      && browserWs.readyState === WebSocket.OPEN;
    if (degradedTextOnly) {
      log.error("TTS unavailable after retry — delivering text-only fallback");
    }

    // Wait for client-side playback to finish before declaring TTS done.
    // Audio is PCM int16 @ 24kHz = 48000 bytes/sec.
    if (completed && !abortController.signal.aborted) {
      const playbackDurationMs = (totalAudioBytes / 48000) * 1000;
      const elapsedMs = Date.now() - streamStartMs;
      const remainingMs = playbackDurationMs - elapsedMs + 300; // +300ms buffer for jitter
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remainingMs);
          const onAbort = () => { clearTimeout(timer); resolve(); };
          abortController.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }

    ttsSpeaking = false;
    if (ttsAbortController === abortController) {
      ttsAbortController = null;
    }

    const delivered = (completed || degradedTextOnly) && !abortController.signal.aborted;
    if (delivered && browserWs.readyState === WebSocket.OPEN) {
      sendTranscriptTextOnce();
      browserWs.send(JSON.stringify({ type: "tts_ended" }));
    }

    return delivered;
  }

  /**
   * Speak text and handle post-TTS actions (transitions, farewell, etc).
   * This replaces the old S2S SayHello + TTS_ENDED event handling.
   */
  async function speakAndHandle(text: string, options?: {
    trackInTranscript?: boolean;
    pendingTransition?: boolean;
    pendingPrevTransition?: boolean;
    pendingFarewell?: boolean;
    pendingFinalTimeout?: boolean;
  }): Promise<void> {
    const completed = await speakText(text);
    if (!completed) return;

    if (options?.trackInTranscript !== false) {
      questionTranscript.push({ role: "assistant", text });
      lastAssistantMessageWallClockMs = Date.now();
    }

    // Post-TTS actions
    if (options?.pendingFarewell) {
      endInterview();
      return;
    }

    if (options?.pendingFinalTimeout) {
      finalResponseTimeout = setTimeout(() => {
        if (!interviewDone && !awaitingFinalResponse) return;
        awaitingFinalResponse = false;
        if (finalResponseTimeout) {
          clearTimeout(finalResponseTimeout);
          finalResponseTimeout = null;
        }
        const farewell = buildFarewellSayHello(isZh);
        log.info("No final response after timeout, sending farewell");
        speakAndHandle(farewell, { pendingFarewell: true }).catch(log.error);
      }, 15_000);
    }

    if (options?.pendingTransition && !isTransitioning && !interviewDone) {
      const isLastQuestion = currentQuestionIndex >= sortedQuestions.length - 1;
      if (isLastQuestion) {
        log.info("TTS ended on last Q — waiting 15s for user response before wrap-up");
        pendingLastQuestionTimeout = setTimeout(() => {
          pendingLastQuestionTimeout = null;
          if (!isTransitioning && !interviewDone && !generatingResponse) {
            log.info("No user response on last Q — auto-wrapping up");
            handleTransition(true).catch(log.error);
          }
        }, 15_000);
      } else {
        log.info("TTS ended — triggering queued transition");
        handleTransition(true).catch(log.error);
      }
    }

    if (options?.pendingPrevTransition && !isTransitioning && !interviewDone && currentQuestionIndex > 0) {
      log.info("TTS ended — queuing PREV transition after audio flush delay");
      setTimeout(() => {
        handlePreviousTransition(true).catch(log.error);
      }, 1500);
    }
  }

  // ── Interview lifecycle ────────────────────────────────────────

  function endInterview() {
    if (interviewDone) return;
    if (!ownsPersistedSession()) {
      interviewDone = true;
      return;
    }
    interviewDone = true;
    clearPendingAsrFinal();
    awaitingFinalResponse = false;
    cancelTts();
    if (finalResponseTimeout) {
      clearTimeout(finalResponseTimeout);
      finalResponseTimeout = null;
    }
    if (pendingLastQuestionTimeout) {
      clearTimeout(pendingLastQuestionTimeout);
      pendingLastQuestionTimeout = null;
    }
    browserWs.send(JSON.stringify({ type: "interview_complete" }));
    log.info("Interview complete signal sent");
    farewellCompleted = true;
    // Recruitment completion is authoritative only after /api/voice/save has
    // verified eight question-bound USER answers. The relay can signal that
    // the farewell is done, but must not pre-authorize a completed result.
    if (ctxSessionId) {
      const record = liveSessions.get(ctxSessionId);
      if (record) record.status = "ended";
      if (!isOprunRecruitmentInterview) {
        void persistSessionStatus(ctxSessionId, "COMPLETED", "relay_farewell_done");
      }
    }
  }

  function queueFarewellAndEnd(reason: string) {
    if (interviewDone || endingInterview) return;
    if (!ownsPersistedSession()) {
      interviewDone = true;
      endingInterview = true;
      return;
    }
    endingInterview = true;

    awaitingFinalResponse = false;
    generatingResponse = false;
    clearPendingAsrFinal();
    cancelTts();

    if (finalResponseTimeout) {
      clearTimeout(finalResponseTimeout);
      finalResponseTimeout = null;
    }
    if (pendingLastQuestionTimeout) {
      clearTimeout(pendingLastQuestionTimeout);
      pendingLastQuestionTimeout = null;
    }

    const currentQ = sortedQuestions[currentQuestionIndex];
    const transcriptSnapshot = [...questionTranscript];
    if (transcriptSnapshot.length > 0) {
      summarizeQuestion(currentQ.text, transcriptSnapshot, isZh, llmRoute)
        .then((summary) => questionSummaries.push(summary))
        .catch(log.error);
    }

    const farewell = buildFarewellSayHello(isZh);
    log.info(reason);

    speakAndHandle(farewell, { pendingFarewell: true }).catch((err) => {
      log.error("Farewell TTS failed:", err);
      endInterview();
    });

    // Safety net
    setTimeout(() => {
      if (!interviewDone) {
        log.warn("Farewell TTS timed out after 10s — forcing interview end");
        endInterview();
      }
    }, 10_000);
  }

  // ── LLM-controlled response generator ─────────────────────────

  async function buildAgentContext(): Promise<AgentContext> {
    const previousContext = questionSummaries
      .map((s, i) => `Q${i + 1} (${sortedQuestions[i]?.text.slice(0, 50)}): ${s}`)
      .join("\n");

    const currentQ = sortedQuestions[currentQuestionIndex];
    const agentCtx: AgentContext = { memory: previousContext };

    if (currentQ.type === "CODING" && currentCodeContent) {
      agentCtx.codeContent = currentCodeContent;
      agentCtx.codeLanguage = currentCodeLanguage;
    }

    if (currentQ.type === "WHITEBOARD") {
      await requestFreshWhiteboardSnapshot("agent_context");

      if (whiteboardDirty && latestWhiteboardImage) {
        log.info(`Whiteboard vision: calling vision LLM (inline wait ${WHITEBOARD_VISION_INLINE_TIMEOUT_MS}ms)`);
        const visionPromise = describeWhiteboard(latestWhiteboardImage, isZh);
        const result = await Promise.race([
          visionPromise.then((desc) => ({ desc, timedOut: false })),
          new Promise<{ desc: string; timedOut: boolean }>((resolve) =>
            setTimeout(() => resolve({ desc: "", timedOut: true }), WHITEBOARD_VISION_INLINE_TIMEOUT_MS)
          ),
        ]);
        if (!result.timedOut && result.desc) {
          cachedWhiteboardDescription = result.desc;
          whiteboardDirty = false;
          log.info(`Whiteboard vision: description ready (${result.desc.length} chars)`);
        } else if (result.timedOut) {
          agentCtx.whiteboardLoading = true;
          pendingWhiteboardVision = true;
          log.info("Whiteboard vision: still running; deferring to two-phase follow-up");
          visionPromise.then((desc) => {
            if (desc) {
              cachedWhiteboardDescription = desc;
              whiteboardDirty = false;
              log.info(`Whiteboard vision: background description ready (${desc.length} chars)`);
            }
            pendingWhiteboardVision = false;
          }).catch(() => { pendingWhiteboardVision = false; });
        } else if (!result.timedOut && !result.desc) {
          agentCtx.whiteboardLoading = true;
          log.info("Whiteboard vision: returned empty (likely API error), treating as loading");
        }
      } else if (!latestWhiteboardImage) {
        log.info("Whiteboard: no image received from frontend yet");
      }

      if (cachedWhiteboardDescription) {
        agentCtx.whiteboardDescription = cachedWhiteboardDescription;
      }
    }

    if (lastResponseWasCorrection) {
      agentCtx.correctionGuard = isZh
        ? "\n**重要：你上一条回复要求受访者重新考虑或修改答案。他们还没有回应你的纠正。等待他们的回答，绝对不要加 [NEXT]。**\n"
        : "\n**IMPORTANT: Your last response asked the participant to reconsider or revise their answer. They have NOT yet responded to your correction. Wait for their answer. Do NOT add [NEXT] under any circumstances.**\n";
    }

    if (recentAgentResponses.length >= 2) {
      const last = recentAgentResponses[recentAgentResponses.length - 1];
      const prev = recentAgentResponses[recentAgentResponses.length - 2];
      if (last && prev && isSimilarResponse(last, prev)) {
        agentCtx.antiRepetition = isZh
          ? `\n**重要：你上面的回复已经重复了（"${last.slice(0, 40)}..."）。你必须用完全不同的方式回应。仔细阅读受访者最后一句话，如果他们在问你问题，请直接回答。不要再说类似的话。不要像结束整场访谈那样告别（除非当前已是最后一题且流程要求收尾）。**\n`
          : `\n**IMPORTANT: Your previous responses have been repetitive ("${last.slice(0, 40)}..."). You MUST respond differently. Read the participant's last message carefully — if they are asking you a question, answer it directly. Do NOT repeat similar phrasing. Do NOT speak as if the entire interview is ending (unless this is truly the final wrap-up for the last question).**\n`;
        log.info("Anti-repetition guard activated");
      }
    }

    return agentCtx;
  }

  async function generateControlledResponse(opts?: { forceSkip?: boolean }): Promise<string> {
    const forceSkip = opts?.forceSkip ?? false;
    const currentQ = sortedQuestions[currentQuestionIndex];
    const history = PROMPTS.formatHistory(questionTranscript, isZh);
    const agentCtx = await buildAgentContext();
    const latestAnsweredExchange = getLatestAnsweredExchange();
    const isRecruitmentControlTurn = Boolean(
      isOprunRecruitmentInterview
      && latestAnsweredExchange?.participant
      && isRecruitmentConversationControl(latestAnsweredExchange.participant),
    );

    const qOpts = currentQ.options as { options: string[]; allowMultiple?: boolean } | null | undefined;
    let choiceInstruction = "";
    if (currentQ.type === "SINGLE_CHOICE" && qOpts?.options?.length) {
      const labels = qOpts.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(", ");
      choiceInstruction = bt(isZh, PROMPTS.choiceInstruction.singleChoice(labels));
    } else if (currentQ.type === "MULTIPLE_CHOICE" && qOpts?.options?.length) {
      const labels = qOpts.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(", ");
      choiceInstruction = bt(isZh, PROMPTS.choiceInstruction.multipleChoice(labels));
    } else if (currentQ.type === "CODING") {
      choiceInstruction = bt(isZh, PROMPTS.choiceInstruction.coding(NEXT_TOKEN, PREV_TOKEN));
    } else if (currentQ.type === "WHITEBOARD") {
      choiceInstruction = bt(isZh, PROMPTS.choiceInstruction.whiteboard(NEXT_TOKEN, PREV_TOKEN));
    } else if (currentQ.type === "RESEARCH") {
      choiceInstruction = bt(isZh, PROMPTS.choiceInstruction.research(NEXT_TOKEN, PREV_TOKEN));
    }

    const effectiveMaxFollowUps = isOprunRecruitmentInterview
      ? 1
      : currentQ.type === "RESEARCH"
        ? Math.max(maxFollowUps, 7)
        : maxFollowUps;
    const followUpsDone = Math.max(0, userTurnsOnCurrentQ - 1);
    const isRecruitmentInlineQuestion = (
      isOprunRecruitmentInterview
      && currentQuestionIndex >= 1
      && currentQuestionIndex <= 6
    );
    const isRecruitmentFinalVerification = (
      isOprunRecruitmentInterview && currentQuestionIndex === 7
    );
    const sessionTurnsLeft = isOprunRecruitmentInterview
      ? isRecruitmentInlineQuestion
        ? Math.max(
            0,
            RECRUITMENT_INLINE_FOLLOW_UP_LIMIT
              - recruitmentInlineFollowUpsUsed,
          )
        : isRecruitmentFinalVerification
          ? Math.max(
              0,
              RECRUITMENT_FINAL_FOLLOW_UP_LIMIT
                - recruitmentFinalFollowUpsUsed,
            )
          : 0
      : Math.max(0, GLOBAL_FOLLOW_UP_LIMIT - totalFollowUpsUsed);
    const turnsLeft = Math.min(
      effectiveMaxFollowUps - followUpsDone,
      sessionTurnsLeft,
    );
    let followUpInstruction: string;
    const isCodingOrWhiteboard = currentQ.type === "CODING" || currentQ.type === "WHITEBOARD";

    const followBudgetCtx = {
      isLastQuestion: currentQuestionIndex >= sortedQuestions.length - 1,
    };

    if (!forceSkip && isRecruitmentControlTurn) {
      followUpInstruction = isZh
        ? `候选人刚才只是寒暄、确认声音或请求重述，并没有回答当前计分题。请像真人面试官一样简短回应，然后自然、原意不变地重述当前题目。不要追问证据，不要加 ${NEXT_TOKEN}，这次不计入追问预算。`
        : `The participant only greeted you, checked audio, or asked for repetition; they did not answer the scored question. Respond briefly and naturally, then restate the current question without changing its meaning. Do not probe evidence, do not append ${NEXT_TOKEN}, and do not consume a follow-up.`;
    } else if (forceSkip) {
      const skipOverride = isZh
        ? `⚠️ 受访者已明确要求跳过/进入下一题。你必须简短回应（如"好的，没问题"），然后在回复末尾加上 ${NEXT_TOKEN}。不要试图继续提问或鼓励。`
        : `⚠️ The participant has EXPLICITLY asked to skip / move on to the next question. You MUST briefly acknowledge (e.g. "Sure, no problem") and append ${NEXT_TOKEN} at the end. Do NOT try to help further or ask more questions.`;
      followUpInstruction = skipOverride;
      choiceInstruction = "";
    } else if (lastResponseWasCorrection) {
      followUpInstruction = isZh
        ? `等待受访者回应你的纠正。不要加 ${NEXT_TOKEN}。`
        : `Wait for the participant to respond to your correction. Do NOT add ${NEXT_TOKEN}.`;
    } else if (isCodingOrWhiteboard) {
      followUpInstruction = bt(isZh, PROMPTS.followUp.codingWb(NEXT_TOKEN));
    } else if (turnsLeft <= -1) {
      followUpInstruction = bt(isZh, PROMPTS.followUp.pastLimit(NEXT_TOKEN, followBudgetCtx));
    } else if (turnsLeft <= 0) {
      followUpInstruction = bt(isZh, PROMPTS.followUp.atLimit(NEXT_TOKEN, followBudgetCtx));
    } else if (turnsLeft === 1) {
      followUpInstruction = bt(isZh, PROMPTS.followUp.oneLeft(NEXT_TOKEN));
    } else {
      followUpInstruction = bt(isZh, PROMPTS.followUp.remaining(turnsLeft, NEXT_TOKEN));
    }
    if (
      !forceSkip
      && !isRecruitmentControlTurn
      && turnsLeft > 0
      && isRecruitmentInlineQuestion
    ) {
      followUpInstruction = isZh
        ? `这是Q2至Q7的就地证据核验机会。只有回答缺少以下一项关键证据时才追问一次：本人职责边界、实施机制或工具、选择依据、结果数据口径、失败与验证、时间线。每次只问一个最关键缺口，语气专业自然；回答已经充分就简短确认并加 ${NEXT_TOKEN} 进入下一题。`
        : `This is an in-place evidence check for Q2-Q7. Ask one concise follow-up only when the answer lacks one material item: personal ownership, implementation mechanism or tools, decision rationale, metric definition, failure and validation, or timeline. Ask only the single most important gap. If evidence is sufficient, acknowledge and append ${NEXT_TOKEN}.`;
    } else if (
      !forceSkip
      && !isRecruitmentControlTurn
      && turnsLeft > 0
      && isRecruitmentFinalVerification
    ) {
      followUpInstruction = isZh
        ? `这是全场最多一次、但不是必问的最终动态核验机会。先判断前面证据是否已经足够：若足够，简短确认并加 ${NEXT_TOKEN} 收尾；只有仍存在会实质影响录用判断的未证实核心主张、技能缺口或前后矛盾时，才选择其中最重要的一处问一个简短确认问题。这是“只能围绕当前题”的唯一例外，不得同时问两件事。`
        : `This is one optional final cross-question verification opportunity, not a mandatory question. If prior evidence is sufficient, acknowledge briefly and append ${NEXT_TOKEN}. Only when one unresolved claim, skill gap, or inconsistency could materially change the hiring decision may you ask one concise verification question about that single issue.`;
    }
    const mustAdvanceForFollowUpLimit =
      !forceSkip &&
      !lastResponseWasCorrection &&
      !isCodingOrWhiteboard &&
      !isRecruitmentControlTurn &&
      turnsLeft <= 0;

    const promptParams = {
      aiName: ctx.aiName,
      title: ctx.title,
      objective: ctx.objective,
      qNum: currentQuestionIndex + 1,
      totalQs: sortedQuestions.length,
      qText: currentQ.text,
      qDescription: currentQ.description,
      qType: currentQ.type,
      choiceInstruction,
      history,
      followUpInstruction,
      nextToken: NEXT_TOKEN,
      prevToken: PREV_TOKEN,
      userTurns: userTurnsOnCurrentQ,
      previousContext: agentCtx.memory || undefined,
      codeContent: agentCtx.codeContent,
      codeLanguage: agentCtx.codeLanguage,
      whiteboardDescription: agentCtx.whiteboardDescription,
      whiteboardLoading: agentCtx.whiteboardLoading,
      correctionGuard: agentCtx.correctionGuard,
      antiRepetition: agentCtx.antiRepetition,
      recentInterviewerResponses: recentAgentResponses.slice(-3),
      latestInterviewerPrompt: latestAnsweredExchange?.interviewer,
      latestParticipantAnswer: latestAnsweredExchange?.participant,
      forceLanguage: userLangSamples.length > 0 ? (isZh ? "zh" : "en") : undefined,
    };

    const prompt = bt(isZh, isCodingOrWhiteboard
      ? PROMPTS.response.codingWb(promptParams)
      : PROMPTS.response.normal(promptParams));

    const startMs = Date.now();
    const latestParticipantAnswer = [...questionTranscript]
      .reverse()
      .find((entry) => entry.role === "user")?.text || "";
    const deterministicMetricFollowUp = (
      turnsLeft > 0
      && isRecruitmentInlineQuestion
      && !isRecruitmentControlTurn
    )
      ? recruitmentMetricEvidenceFollowUp(
          currentQuestionIndex,
          latestParticipantAnswer,
          isZh,
        )
      : null;
    let response = deterministicMetricFollowUp || await callRelayLLM(prompt, undefined, {
      stage: "interview-turn",
      question: currentQuestionIndex + 1,
    }, llmRoute);
    if (deterministicMetricFollowUp) {
      log.info("Using deterministic Q4 metric-evidence follow-up");
    }

    response = response.replace(/^(追问型|结束型|FOLLOW[- ]?UP|WRAP[- ]?UP)\s*[:：]\s*/i, "").trim();

    const turnBudgetFinalized = finalizeTurnBudgetResponse({
      response,
      nextToken: NEXT_TOKEN,
      mustAdvance: mustAdvanceForFollowUpLimit,
      keepsConversationOpen: replyKeepsConversationOpen(
        response.replace(NEXT_TOKEN, "").replace(PREV_TOKEN, "").trim(),
        isZh,
      ),
      transitionResponse: isZh ? "好的，谢谢你的分享。" : "Thanks for sharing.",
    });
    if (turnBudgetFinalized.changed) {
      log.info("Forced [NEXT] — follow-up limit reached");
      response = turnBudgetFinalized.response;
    }

    if (!forceSkip) {
      if (
        !mustAdvanceForFollowUpLimit &&
        response.includes(NEXT_TOKEN) &&
        replyKeepsConversationOpen(response.replace(NEXT_TOKEN, ""), isZh)
      ) {
        log.info("Stripped [NEXT] — response still invites a participant reply");
        response = response.replace(NEXT_TOKEN, "").trim();
      }

      if (response.includes(NEXT_TOKEN) && userTurnsOnCurrentQ === 0) {
        log.info("Stripped [NEXT] — no user response on this question yet");
        response = response.replace(NEXT_TOKEN, "").trim();
      }

      if (response.includes(NEXT_TOKEN) && lastResponseWasCorrection) {
        log.info("Stripped [NEXT] — awaiting response to correction");
        response = response.replace(NEXT_TOKEN, "").trim();
      }
    }

    if (forceSkip && !response.includes(NEXT_TOKEN)) {
      log.info("Force-adding [NEXT] — user explicitly asked to skip");
      response = response.trimEnd() + " " + NEXT_TOKEN;
    }

    lastResponseWasCorrection = isCorrection(response, isZh);
    if (lastResponseWasCorrection) {
      log.info("Response detected as correction — will guard next turn");
    }

    const spokenResponse = response.replace(NEXT_TOKEN, "").replace(PREV_TOKEN, "").trim();
    if (shouldConsumeFollowUpBudget({
      isRecruitmentInterview: isOprunRecruitmentInterview,
      hasNextTransition: response.includes(NEXT_TOKEN),
      hasPreviousTransition: response.includes(PREV_TOKEN),
      userTurnsOnCurrentQuestion: userTurnsOnCurrentQ,
      isRecruitmentControlTurn,
      keepsConversationOpen: replyKeepsConversationOpen(spokenResponse, isZh),
    })) {
      totalFollowUpsUsed = Math.min(
        isOprunRecruitmentInterview
          ? OPRUN_RECRUITMENT_FOLLOW_UP_LIMIT
          : GLOBAL_FOLLOW_UP_LIMIT,
        totalFollowUpsUsed + 1,
      );
      if (isRecruitmentInlineQuestion) {
        recruitmentInlineFollowUpsUsed = Math.min(
          RECRUITMENT_INLINE_FOLLOW_UP_LIMIT,
          recruitmentInlineFollowUpsUsed + 1,
        );
      } else if (isRecruitmentFinalVerification) {
        recruitmentFinalFollowUpsUsed = Math.min(
          RECRUITMENT_FINAL_FOLLOW_UP_LIMIT,
          recruitmentFinalFollowUpsUsed + 1,
        );
      }
      log.info(
        `Global follow-up budget: ${totalFollowUpsUsed}/${
          isOprunRecruitmentInterview
            ? OPRUN_RECRUITMENT_FOLLOW_UP_LIMIT
            : GLOBAL_FOLLOW_UP_LIMIT
        }`,
      );
      await persistRecruitmentFollowUpBudget();
    }
    if (spokenResponse) {
      recentAgentResponses.push(spokenResponse);
      if (recentAgentResponses.length > 5) recentAgentResponses.shift();
    }

    log.info(`Response LLM (${Date.now() - startMs}ms, turn ${userTurnsOnCurrentQ}): "${response.slice(0, 100)}..."`);
    return response;
  }

  // ── Two-phase whiteboard follow-up ─────────────────────────────

  function scheduleWhiteboardFollowUp() {
    const pollInterval = 300;
    const maxWait = WHITEBOARD_VISION_FOLLOW_UP_MAX_WAIT_MS;
    let waited = 0;

    const poll = () => {
      if (isTransitioning || interviewDone || browserWs.readyState !== WebSocket.OPEN) return;

      if (!pendingWhiteboardVision && cachedWhiteboardDescription) {
        log.info("Whiteboard vision ready — sending follow-up response");
        generatingResponse = true;
        generateControlledResponse()
          .then((followUp) => {
            generatingResponse = false;
            if (!followUp || browserWs.readyState !== WebSocket.OPEN) return;
            const spokenFollowUp = followUp.replace(NEXT_TOKEN, "").replace(PREV_TOKEN, "").trim();
            if (spokenFollowUp) {
              log.info("Sent whiteboard follow-up via TTS");
              speakAndHandle(spokenFollowUp).catch(log.error);
            }
          })
          .catch((err) => {
            log.error("Whiteboard follow-up failed:", err);
            generatingResponse = false;
          });
        return;
      }

      waited += pollInterval;
      if (waited < maxWait) {
        setTimeout(poll, pollInterval);
      } else {
        log.info("Whiteboard vision timed out — no follow-up sent");
      }
    };

    setTimeout(poll, pollInterval);
  }

  // ── Transition handler ──────────────────────────────────────────

  function sendTransitionCancelled(direction: "next" | "previous") {
    if (browserWs.readyState !== WebSocket.OPEN) return;
    browserWs.send(JSON.stringify({
      type: "transition_cancelled",
      direction,
      questionIndex: currentQuestionIndex,
      totalQuestions: sortedQuestions.length,
    }));
  }

  function queueManualTransition(direction: "next" | "previous") {
    pendingManualTransitionDirection = direction;
    cancelTts();
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "transitioning", auto: false, direction }));
    }
    log.info(`Manual ${direction} requested during active transition — queued`);
  }

  function runQueuedManualTransition(): boolean {
    const direction = pendingManualTransitionDirection;
    if (!direction || interviewDone) return false;

    pendingManualTransitionDirection = null;
    isTransitioning = false;

    if (direction === "previous") {
      handlePreviousTransition(false).catch(log.error);
    } else {
      handleTransition(false).catch(log.error);
    }
    return true;
  }

  async function handleTransition(auto = false) {
    if (interviewDone) return;
    if (isTransitioning) {
      if (!auto) queueManualTransition("next");
      return;
    }
    const hasSubstantiveRecruitmentAnswer = questionTranscript.some(
      (entry) => entry.role === "user"
        && !isRecruitmentConversationControl(entry.text)
        && !isUserSkipRequest(entry.text),
    );
    if (
      isOprunRecruitmentInterview
      && currentQuestionIndex < 8
      && !hasSubstantiveRecruitmentAnswer
    ) {
      silenceConfirmPending = false;
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({
          type: "transition_rejected",
          direction: "next",
          reason: "answer_required",
          message: "这道正式计分题还没有收到有效回答，请先按真实情况作答；没有相关经历也可以如实说明。",
          questionIndex: currentQuestionIndex,
          totalQuestions: sortedQuestions.length,
        }));
      }
      armSilenceAutoSkip();
      return;
    }
    // 切题:仅在确认收到有效回答后重置本题静默状态。
    silenceAskCount = 0;
    silenceConfirmPending = false;
    const transitionId = ++transitionGeneration;
    isTransitioning = true;
    pendingProgressiveTransition = false;

    // Only wait when the candidate reaches the final currently available
    // progressive question. If a conditional transition Q2 already exists,
    // Q1 must advance to it immediately.
    if (shouldWaitForQuestionExpansion(sortedQuestions, currentQuestionIndex)) {
      const waitUntil = Date.now() + 10_000;
      while (isProgressiveOpeningOnly(sortedQuestions) && Date.now() < waitUntil) {
        await refreshDynamicQuestions();
        if (!isProgressiveOpeningOnly(sortedQuestions)) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (isProgressiveOpeningOnly(sortedQuestions)) {
        isTransitioning = false;
        pendingProgressiveTransition = true;
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(JSON.stringify({
            type: "next_question_not_ready",
            questionIndex: currentQuestionIndex,
            totalQuestions: sortedQuestions.length,
          }));
        }
        await speakAndHandle(
          isZh
            ? "抱歉，下一道个性化题暂未准备好，这是系统异常，我会继续自动重试。本次等待不会作为额外面试题。"
            : "Sorry, the next personalized question is not ready yet. This is a system issue and I will keep retrying automatically. This wait is not an additional interview question.",
          { trackInTranscript: false },
        );
        return;
      }
    }
    clearPendingAsrFinal();
    clearSilenceAutoSkip();

    suppressAsrResults = true;
    disconnectAsr();
    cancelTts();
    generatingResponse = false;

    try {
      browserWs.send(JSON.stringify({ type: "transitioning", auto, direction: "next" }));

      const currentQ = sortedQuestions[currentQuestionIndex];
      const transcriptSnapshot = [...questionTranscript];
      questionTranscript = [];
      asrAccumulator = "";
      userTurnsOnCurrentQ = 0;
      lastResponseWasCorrection = false;
      cachedWhiteboardDescription = "";
      whiteboardDirty = !!latestWhiteboardImage;
      recentAgentResponses.length = 0;
      if (pendingLastQuestionTimeout) {
        clearTimeout(pendingLastQuestionTimeout);
        pendingLastQuestionTimeout = null;
      }

      await refreshDynamicQuestions();
      currentQuestionIndex++;

      if (currentQuestionIndex < sortedQuestions.length) {
        const nextQ = sortedQuestions[currentQuestionIndex];
        const transition = buildTransitionSayHello(currentQuestionIndex, nextQ, isZh);

        browserWs.send(
          JSON.stringify({
            type: "question_change",
            questionIndex: currentQuestionIndex,
            totalQuestions: sortedQuestions.length,
            auto,
          })
        );

        log.info(`→ Q${currentQuestionIndex + 1}/${sortedQuestions.length}: ${nextQ.text.slice(0, 60)}...`);
        const previousQuestionIndex = currentQuestionIndex - 1;
        const summaryPromise = transcriptSnapshot.length > 0
          ? summarizeQuestion(currentQ.text, transcriptSnapshot, isZh, llmRoute)
          : Promise.resolve("");
        const [, summary] = await Promise.all([
          speakAndHandle(transition, { trackInTranscript: false }),
          summaryPromise,
        ]);
        questionSummaries[previousQuestionIndex] = summary;
      } else {
        if (transcriptSnapshot.length > 0) {
          const lastSummary = await summarizeQuestion(
            currentQ.text,
            transcriptSnapshot,
            isZh,
            llmRoute,
          );
          questionSummaries.push(lastSummary);
        }

        if (auto) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (interviewDone) return;
        }

        awaitingFinalResponse = true;
        const wrapUp = buildWrapUpSayHello(isZh);

        log.info("All questions covered, awaiting final response");
        await speakAndHandle(wrapUp, { pendingFinalTimeout: true });
      }
    } catch (err) {
      log.error("Transition error:", err);
    } finally {
      if (transitionGeneration !== transitionId) return;
      if (runQueuedManualTransition()) return;
      isTransitioning = false;
      if (!interviewDone && browserWs.readyState === WebSocket.OPEN) {
        reopenAsr().catch(log.error);
      }
    }
  }

  // ── Previous-question transition handler ───────────────────────

  async function handlePreviousTransition(auto = false) {
    if (interviewDone) return;
    if (currentQuestionIndex <= 0) {
      if (!auto) sendTransitionCancelled("previous");
      return;
    }
    if (isTransitioning) {
      if (!auto) queueManualTransition("previous");
      return;
    }
    const transitionId = ++transitionGeneration;
    isTransitioning = true;
    clearPendingAsrFinal();
    clearSilenceAutoSkip();

    suppressAsrResults = true;
    disconnectAsr();
    cancelTts();
    generatingResponse = false;

    try {
      browserWs.send(JSON.stringify({ type: "transitioning", auto, direction: "previous" }));

      const transcriptSnapshot = [...questionTranscript];
      questionTranscript = [];
      asrAccumulator = "";
      userTurnsOnCurrentQ = 0;
      lastResponseWasCorrection = false;
      cachedWhiteboardDescription = "";
      whiteboardDirty = !!latestWhiteboardImage;
      recentAgentResponses.length = 0;
      if (pendingLastQuestionTimeout) {
        clearTimeout(pendingLastQuestionTimeout);
        pendingLastQuestionTimeout = null;
      }

      const currentQ = sortedQuestions[currentQuestionIndex];
      if (transcriptSnapshot.length > 0) {
        const summary = await summarizeQuestion(
          currentQ.text,
          transcriptSnapshot,
          isZh,
          llmRoute,
        );
        questionSummaries.push(summary);
      }

      currentQuestionIndex--;

      const prevQ = sortedQuestions[currentQuestionIndex];
      const transition = buildReturnSayHello(currentQuestionIndex, prevQ, isZh);

      browserWs.send(
        JSON.stringify({
          type: "question_change",
          questionIndex: currentQuestionIndex,
          totalQuestions: sortedQuestions.length,
          auto: false,
        })
      );

      log.info(`← Q${currentQuestionIndex + 1}/${sortedQuestions.length} (back): ${prevQ.text.slice(0, 60)}...`);

      await speakAndHandle(transition, { trackInTranscript: false });
    } catch (err) {
      log.error("Previous transition error:", err);
    } finally {
      if (transitionGeneration !== transitionId) return;
      if (runQueuedManualTransition()) return;
      isTransitioning = false;
      if (!interviewDone && browserWs.readyState === WebSocket.OPEN) {
        reopenAsr().catch(log.error);
      }
    }
  }

  // ── Handle completed user utterance ────────────────────────────

  function normalizeUserUtteranceKey(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * Volcengine sometimes emits a second definite for the same utterance while ASR results are
   * suppressed (or two finals race before generatingResponse is set). If we already stored this
   * user line and an assistant reply followed, skip — otherwise the flush/queue paths call
   * handleUserUtterance again and the agent speaks twice.
   */
  function isDuplicateUserFinal(userText: string): boolean {
    const key = normalizeUserUtteranceKey(userText);
    if (!key) return false;

    let lastUserIdx = -1;
    for (let i = questionTranscript.length - 1; i >= 0; i--) {
      if (questionTranscript[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0 && lastUserIdx !== questionTranscript.length - 1) {
      const hasAssistantAfter = questionTranscript.slice(lastUserIdx + 1).some(e => e.role === "assistant");

      if (hasAssistantAfter) {
        const lastUserText = questionTranscript[lastUserIdx].text;
        if (shouldSuppressAnsweredAsrFinal(lastUserText, userText)) {
          const merged = mergeAsrSegments(lastUserText, userText);
          if (normalizeUserUtteranceKey(merged).length > normalizeUserUtteranceKey(lastUserText).length) {
            questionTranscript[lastUserIdx] = { role: "user", text: merged };
            rememberAcceptedUserFinal(merged);
          }
          return true;
        }
      }
    }

    return shouldSuppressRecentUserFinalReplay(userText);
  }

  function isReplayOfPendingUserTurn(userText: string): boolean {
    const lastEntry = questionTranscript[questionTranscript.length - 1];
    if (lastEntry?.role !== "user") return false;
    if (!shouldSuppressAnsweredAsrFinal(lastEntry.text, userText)) return false;

    const merged = mergeAsrSegments(lastEntry.text, userText);
    if (normalizeUserUtteranceKey(merged).length > normalizeUserUtteranceKey(lastEntry.text).length) {
      questionTranscript[questionTranscript.length - 1] = { role: "user", text: merged };
      rememberAcceptedUserFinal(merged);
    }
    return true;
  }

  function isSameAsPendingUserTurn(userText: string): boolean {
    const lastEntry = questionTranscript[questionTranscript.length - 1];
    return (
      lastEntry?.role === "user" &&
      normalizeUserUtteranceKey(lastEntry.text) === normalizeUserUtteranceKey(userText)
    );
  }

  function shouldIgnoreAsrInterimReplay(userText: string): boolean {
    return isDuplicateUserFinal(userText);
  }

  function getLatestAnsweredExchange(): { interviewer: string; participant: string } | null {
    const lastEntry = questionTranscript[questionTranscript.length - 1];
    if (lastEntry?.role !== "user") return null;

    for (let i = questionTranscript.length - 2; i >= 0; i--) {
      const entry = questionTranscript[i];
      if (entry.role === "assistant" && entry.text.trim()) {
        return {
          interviewer: entry.text.trim(),
          participant: lastEntry.text.trim(),
        };
      }
    }

    return null;
  }

  /**
   * 第5项开讲门控:true=用户已静默可开讲;false=用户仍在说或等待期间新内容已进来
   * (suppressed/queued),调用方应放弃本次预生成回复,由响应周期收尾统一冲刷处理。
   */
  async function waitForUserQuietBeforeSpeaking(): Promise<boolean> {
    const deadline = Date.now() + USER_SPEAK_GATE_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (
        queuedUserUtteranceWhileGenerating.trim() ||
        pendingUserUtteranceWhileSuppressed.trim()
      ) {
        return false;
      }
      if (Date.now() - lastUserAudioActivityAt >= USER_SPEAK_GATE_QUIET_MS) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    log.info("User still speaking past speak-gate window — deferring prepared response");
    return false;
  }

  async function handleUserUtterance(
    userText: string,
    options?: { allowRecentReplay?: boolean; isChatInput?: boolean },
  ) {
    if (!userText || isTransitioning || interviewDone) return;

    // Fast-path commands work even during TTS/response generation
    if (isUserEndRequest(userText)) {
      queueFarewellAndEnd(`Explicit interview end request: "${userText.slice(0, 80)}"`);
      return;
    }
    if (isFastPrevRequest(userText) || isUserPrevRequest(userText)) {
      log.info("Fast-path: previous question request");
      handlePreviousTransition().catch(log.error);
      return;
    }
    if (isFastNextRequest(userText)) {
      log.info("Fast-path: next question request");
      handleTransition().catch(log.error);
      return;
    }

    // chat 输入是候选人的一次性主动发送,不存在 ASR"滚动重放"问题;
    // 让它走 ASR 抑制启发式会把共享长前缀的连发消息(追问补充、相似
    // 措辞的回答)静默吞掉 90s(生产实测:答后静默、切题被拒)。
    const retryingPendingUserTurnCandidate = isSameAsPendingUserTurn(userText);
    if (
      !options?.isChatInput &&
      !options?.allowRecentReplay &&
      !retryingPendingUserTurnCandidate &&
      isDuplicateUserFinal(userText)
    ) {
      log.info(
        `Skipping duplicate USER final (reply already recorded): "${userText.slice(0, 72)}..."`,
      );
      return;
    }

    // A second final can arrive while we're still in handleUserUtterance (LLM/TTS).
    // The client has already received asr_ended — queue and run after this cycle finishes.
    // 候选人开口:取消"询问后确认切题",留在本题继续听,重置 AFK 计数与静默询问计数
    clearSilenceAutoSkip();
    silenceAskCount = 0;
    silenceConfirmPending = false;
    unansweredQuestionsStreak = 0;

    if (generatingResponse) {
      const duplicateWhileGenerating =
        !options?.isChatInput &&
        (isReplayOfPendingUserTurn(userText) ||
          (!options?.allowRecentReplay && isDuplicateUserFinal(userText)));
      if (duplicateWhileGenerating) {
        log.info(
          `Skipping duplicate USER final while response is generating: "${userText.slice(0, 72)}..."`,
        );
        return;
      }
      queuedUserUtteranceWhileGenerating = userText;
      queuedUserUtteranceIsChat = Boolean(options?.isChatInput);
      log.info(`Queueing user utterance until current response cycle completes: "${userText.slice(0, 60)}"`);
      return;
    }

    generatingResponse = true;
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: "response_started" }));
    }
    try {
      // User often finishes a phrase right as greeting/answer TTS is still
      // flagged active (barge-in + ASR final ordering). Dropping here leaves
      // the client stuck in isProcessing with no reply — cancel TTS and process.
      if (ttsSpeaking) {
        log.info(`User utterance during TTS — cancelling playback and processing: "${userText.slice(0, 60)}"`);
        cancelTts();
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(JSON.stringify({ type: "interrupt" }));
        }
      }

      updateUserLanguage(userText);
      const retryingPendingUserTurn = retryingPendingUserTurnCandidate;
      if (retryingPendingUserTurn) {
        log.info(`Retrying response for pending USER final: "${userText.slice(0, 72)}..."`);
      } else {
        rememberAcceptedUserFinal(userText);
        questionTranscript.push({ role: "user", text: userText });
        if (
          !isOprunRecruitmentInterview
          || !isRecruitmentConversationControl(userText)
        ) {
          userTurnsOnCurrentQ++;
        }
      }
      lastResponseWasCorrection = false;

      if (pendingLastQuestionTimeout) {
        clearTimeout(pendingLastQuestionTimeout);
        pendingLastQuestionTimeout = null;
        log.info("User spoke — cancelled pending last-Q transition");
      }

      if (awaitingFinalResponse) {
        awaitingFinalResponse = false;
        if (finalResponseTimeout) {
          clearTimeout(finalResponseTimeout);
          finalResponseTimeout = null;
        }
        const farewell = buildFarewellSayHello(isZh);
        log.info("Final response received, sending farewell");
        await speakAndHandle(farewell, { pendingFarewell: true });
        return;
      }

      const userWantsSkip = isUserSkipRequest(userText);
      if (userWantsSkip) log.info(`User skip intent detected: "${userText.slice(0, 80)}"`);

      // Suppress ASR result processing during the response cycle.
      // ASR stays alive for barge-in detection; reconnected in finally block.
      suppressAsrResults = true;

      cancelTts();
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({ type: "interrupt" }));
      }

      try {
        const response = await generateControlledResponse({ forceSkip: userWantsSkip });

        if (!response || browserWs.readyState !== WebSocket.OPEN) return;

        let shouldTransition = response.includes(NEXT_TOKEN);
        let shouldGoPrev = response.includes(PREV_TOKEN);
        const spokenText = response.replace(NEXT_TOKEN, "").replace(PREV_TOKEN, "").trim();

        if (!shouldTransition && !shouldGoPrev && userTurnsOnCurrentQ > 0
            && hasImplicitTransition(spokenText) && !replyKeepsConversationOpen(spokenText, isZh)) {
          shouldTransition = true;
          log.info("Implicit transition detected in response text");
        }

        if (!shouldGoPrev && !shouldTransition && hasImplicitPrevTransition(spokenText)) {
          shouldGoPrev = true;
          log.info("Implicit PREV transition detected in response text");
        }

        if (
          shouldTransition &&
          !userWantsSkip &&
          replyKeepsConversationOpen(spokenText, isZh)
        ) {
          shouldTransition = false;
          log.info("Stripped transition — spoken response still invites a reply");
        }

        const currentType = sortedQuestions[currentQuestionIndex]?.type;
        if (shouldTransition && !userWantsSkip && (currentType === "CODING" || currentType === "WHITEBOARD")) {
          if (spokenText.length > 80) {
            shouldTransition = false;
            log.info(`Stripped transition — coding/wb response too long (${spokenText.length} chars)`);
          }
        }

        if (spokenText) {
          if (!(await waitForUserQuietBeforeSpeaking())) {
            log.info(
              `Deferring prepared response — candidate still speaking: "${spokenText.slice(0, 60)}..."`,
            );
            return;
          }
          log.info("Sent controlled response via TTS");
          await speakAndHandle(spokenText, {
            pendingTransition: shouldTransition,
            pendingPrevTransition: shouldGoPrev && currentQuestionIndex > 0,
          });
        } else if (shouldGoPrev && currentQuestionIndex > 0) {
          handlePreviousTransition().catch(log.error);
        } else if (shouldTransition) {
          handleTransition(true).catch(log.error);
        }

        if (pendingWhiteboardVision && !shouldTransition && !shouldGoPrev) {
          scheduleWhiteboardFollowUp();
        }
      } catch (err) {
        log.error("Response generation failed:", err);
      } finally {
        generatingResponse = false;
        if (
          !interviewDone
          && !isTransitioning
          && browserWs.readyState === WebSocket.OPEN
        ) {
          try {
            await reopenAsr();
            const followUp = queuedUserUtteranceWhileGenerating.trim();
            const followUpIsChat = queuedUserUtteranceIsChat;
            queuedUserUtteranceWhileGenerating = "";
            queuedUserUtteranceIsChat = false;
            if (followUp && (followUpIsChat || !isDuplicateUserFinal(followUp))) {
              await handleUserUtterance(
                followUp,
                followUpIsChat ? { isChatInput: true } : undefined,
              );
            } else if (followUp) {
              log.info(
                `Skipping queued user utterance — duplicate of answered turn: "${followUp.slice(0, 60)}..."`,
              );
            }
          } catch (err) {
            log.error("Post-response reopen/drain failed:", err);
          }
        }
      }
    } finally {
      generatingResponse = false;
    }
  }

  // ── Connect ASR ────────────────────────────────────────────────

  let asrIntentionalClose = false;

  /** Gracefully close the current ASR session (send end-of-stream). */
  function disconnectAsr() {
    asrIntentionalClose = true;
    clearPendingAsrFinal();
    clearHeldBargeInInterim();
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (asrWs && asrWs.readyState === WebSocket.OPEN && asrAlive) {
      try {
        asrAudioSeq++;
        asrWs.send(buildBigModelAudioRequest(Buffer.alloc(0), asrAudioSeq, true));
      } catch { /* ignore */ }
    }
    if (asrWs) {
      asrWs.removeAllListeners();
      try { asrWs.close(); } catch { /* ignore */ }
    }
    asrWs = null;
    asrAlive = false;
    asrAccumulator = "";
    asrSessionFirstSpeechAt = 0;
    log.info("ASR disconnected (intentional)");
  }

  /** Reconnect ASR after response cycle so accumulated echo text is cleared. */
  function clearSilenceAutoSkip() {
    if (silenceAutoSkipTimer) {
      clearTimeout(silenceAutoSkipTimer);
      silenceAutoSkipTimer = null;
    }
  }
  /** 静默计时:先问是否答完,绝不直接切题(王总 2026-08-21) */
  function armSilenceAutoSkip() {
    clearSilenceAutoSkip();
    if (interviewDone || endingInterview) return;
    silenceAutoSkipTimer = setTimeout(() => {
      silenceAutoSkipTimer = null;
      if (interviewDone || endingInterview) return;
      // 小君还在说话/出题/切题时,顺延再看(不打断小君)
      if (isTransitioning || generatingResponse || ttsSpeaking || awaitingFinalResponse) {
        armSilenceAutoSkip();
        return;
      }
      if (silenceAskCount >= MAX_SILENT_ASKS_PER_QUESTION) {
        if (isOprunRecruitmentInterview) {
          log.warn("正式计分题两次提醒后仍无回应,标记面试未完成,绝不跳题");
          abandonForInactivity();
        } else {
          log.info("本题已询问 2 次仍无回应,进入下一题");
          void advanceAfterSilence();
        }
        return;
      }
      silenceAskCount += 1;
      silenceConfirmPending = true;
      log.info(`候选人静默 ${SILENCE_ASK_MS / 1000}s,小君询问是否答完(第 ${silenceAskCount} 次)`);
      void speakText(bt(isZh, SPOKEN.silenceAsk())).catch((err) =>
        log.error("静默询问 TTS 失败:", err),
      );
      armSilenceConfirm();
    }, SILENCE_ASK_MS);
  }

  /** 询问后继续沉默：招聘面试继续留在原题，绝不把沉默当成回答。 */
  function armSilenceConfirm() {
    clearSilenceAutoSkip();
    if (interviewDone || endingInterview || !silenceConfirmPending) return;
    silenceAutoSkipTimer = setTimeout(() => {
      silenceAutoSkipTimer = null;
      if (interviewDone || endingInterview || !silenceConfirmPending) return;
      if (isTransitioning || generatingResponse || ttsSpeaking || awaitingFinalResponse) {
        armSilenceConfirm();
        return;
      }
      silenceConfirmPending = false;
      if (isOprunRecruitmentInterview) {
        if (silenceAskCount >= MAX_SILENT_ASKS_PER_QUESTION) {
          log.warn("正式计分题持续静默,标记面试未完成,绝不跳题");
          abandonForInactivity();
        } else {
          log.info("正式计分题提醒后仍静默,继续停留原题并再次等待");
          armSilenceAutoSkip();
        }
      } else {
        log.info("询问后候选人继续沉默,进入下一题");
        void advanceAfterSilence();
      }
    }, SILENCE_CONFIRM_MS);
  }

  async function advanceAfterSilence() {
    // AFK 守卫:连续 2 道题零回答(两次询问均无回应) → 提前诚实收尾
    if (unansweredQuestionsStreak >= MAX_UNANSWERED_QUESTIONS_STREAK) {
      log.warn("连续多题零回答,判定候选人已离开,提前收尾");
      abandonForInactivity();
      return;
    }
    unansweredQuestionsStreak += 1;
    silenceAskCount = 0;
    silenceConfirmPending = false;
    await handleTransition(true).catch(log.error);
  }

  /** AFK 守卫:页面开着但人不在,空转两题后诚实收尾,不留全空回答记录 */
  function abandonForInactivity() {
    if (interviewDone || endingInterview) return;
    if (!ownsPersistedSession()) {
      interviewDone = true;
      endingInterview = true;
      clearSilenceAutoSkip();
      clearPendingAsrFinal();
      cancelTts();
      return;
    }
    endingInterview = true;
    interviewDone = true;
    clearSilenceAutoSkip();
    clearPendingAsrFinal();
    cancelTts();
    if (ctxSessionId) {
      const record = liveSessions.get(ctxSessionId);
      if (record) record.status = "ended";
      void persistSessionStatus(ctxSessionId, "ABANDONED", "candidate_inactive");
    }
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({
        type: "interview_incomplete",
        reason: "candidate_inactive",
        message: "长时间未收到回答，本次面试已暂停并标记为未完成，不会生成完成结果。请联系招聘负责人重新安排。",
      }));
    }
    log.info("Interview abandoned for inactivity");
  }

  async function reopenAsr() {
    try {
      await connectAsr();
      if (!keepAliveInterval) {
        keepAliveInterval = setInterval(() => {
          if (!asrAlive || !asrWs || asrWs.readyState !== WebSocket.OPEN) return;
          asrAudioSeq++;
          asrWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), asrAudioSeq));
        }, 5000);
      }
      // Only clear suppression if no new response cycle is running
      if (!generatingResponse) {
        suppressAsrResults = false;
      }

      const flushed = pendingUserUtteranceWhileSuppressed.trim();
      pendingUserUtteranceWhileSuppressed = "";
      if (
        flushed &&
        !interviewDone &&
        browserWs.readyState === WebSocket.OPEN &&
        !looksLikeAssistantPlaybackEcho(flushed, questionTranscript) &&
        !isDuplicateUserFinal(flushed) &&
        !shouldIgnoreVolcContinuationFragment(
          flushed,
          questionTranscript,
          lastAssistantMessageWallClockMs,
          isZh,
        )
      ) {
        log.info(`ASR suppression flush — deferred user: "${flushed.slice(0, 72)}..."`);
        browserWs.send(JSON.stringify({
          type: "asr",
          data: { results: [{ text: flushed, definite: true }] },
        }));
        browserWs.send(JSON.stringify({ type: "asr_ended", text: flushed }));
        await handleUserUtterance(flushed);
      } else if (flushed && isDuplicateUserFinal(flushed)) {
        log.info(
          `ASR suppression flush skipped — duplicate USER final (already answered): "${flushed.slice(0, 72)}..."`,
        );
      } else if (
        flushed &&
        shouldIgnoreVolcContinuationFragment(
          flushed,
          questionTranscript,
          lastAssistantMessageWallClockMs,
          isZh,
        )
      ) {
        log.info(
          `ASR suppression flush skipped — split-noise fragment: "${flushed.slice(0, 72)}..."`,
        );
      }

      log.info("ASR reconnected — ready for user input");
      if (
        !interviewDone
        && !endingInterview
        && !isTransitioning
        && !generatingResponse
        && !ttsSpeaking
        && browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.send(JSON.stringify({ type: "input_ready" }));
      }
    } catch (err) {
      log.error("ASR reopen failed:", err instanceof Error ? err.message : err);
      autoReconnectAsr().catch((reconnectErr) => {
        log.error("All ASR reconnect attempts failed:", reconnectErr instanceof Error ? reconnectErr.message : reconnectErr);
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(JSON.stringify({ type: "disconnected" }));
          browserWs.close();
        }
      });
    }
  }

  function buildAsrContext(): Record<string, unknown> | undefined {
    const contextData: { text: string }[] = [];

    const currentQ = sortedQuestions[currentQuestionIndex];
    if (currentQ) {
      contextData.push({ text: `Interview topic: ${ctx.title}` });
      contextData.push({ text: `Current question: ${currentQ.text}` });
    }

    const recentTranscript = questionTranscript.slice(-6);
    for (const entry of recentTranscript) {
      contextData.push({ text: `${entry.role}: ${entry.text}` });
    }

    if (contextData.length === 0) return undefined;
    return {
      context: JSON.stringify({
        context_type: "dialog_ctx",
        context_data: contextData,
      }),
    };
  }

  async function connectAsr() {
    await scheduleAsrConnect(connectAsrUngated);
  }

  async function connectAsrUngated() {
    asrIntentionalClose = false;
    const reqid = randomUUID().replace(/-/g, "");
    asrAudioSeq = 1;

    const asrConfig: BigModelAsrConfig = {
      language: resolveBigModelAsrLanguage(ctx.language),
      format: "pcm",
      rate: 16000,
      bits: 16,
      channels: 1,
      codec: "raw",
      showUtterance: true,
      resultType: "full",
      enablePunc: true,
      enableDdc: true,
      endWindowSize: ASR_END_WINDOW_MS,
      forceToSpeechTime: ASR_FORCE_SPEECH_MS,
      enableNonstream: true,
      ssdVersion: "200",
      corpus: buildAsrContext(),
    };

    if (asrWs) {
      asrWs.removeAllListeners();
      try { asrWs.close(); } catch { /* ignore */ }
    }

    const wsHeaders = buildBigModelHeaders(
      ASR_APP_ID, ASR_ACCESS_TOKEN, reqid, ASR_RESOURCE_ID,
      ASR_API_KEY || undefined,
    );
    asrWs = new WebSocket(BIGMODEL_ASR_URL, { headers: wsHeaders });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ASR connect timeout")), 10000);
      asrWs!.on("open", () => { clearTimeout(t); resolve(); });
      asrWs!.on("error", (e) => { clearTimeout(t); reject(e); });
      asrWs!.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          clearTimeout(t);
          log.error(`ASR WebSocket rejected: HTTP ${res.statusCode} — ${body}`);
          reject(new Error(`ASR server responded ${res.statusCode}: ${body}`));
        });
      });
    });
    log.info(`ASR connected: resource=${ASR_RESOURCE_ID}`);

    asrWs.send(buildBigModelFullRequest(asrConfig, reqid));
    asrAlive = true;
    armSilenceAutoSkip();

    asrWs.on("message", (data: Buffer) => {
      try {
        const resp = parseAsrResponse(Buffer.from(data));

        if (resp.errorCode != null) {
          log.error(`ASR error: ${resp.errorCode} ${resp.errorMessage}`);
          return;
        }

        if (interviewDone) return;

        // Unified handler for both utterance-based and text-based ASR results
        const results: { text: string; definite: boolean }[] = [];
        if (resp.utterances) {
          for (const utt of resp.utterances) {
            if (utt.text) results.push({ text: utt.text, definite: !!utt.definite });
          }
        } else if (resp.text) {
          results.push({ text: resp.text, definite: !!resp.isLastPackage });
        }

        if (results.length === 0 && resp.messageType !== 1 && resp.messageType !== 9) {
          log.info(`ASR non-text msg: type=${resp.messageType}, code=${resp.code}, seq=${resp.sequence}`);
        }

        for (const r of results) {
          if (r.text && r.text.trim()) armSilenceAutoSkip();
          // Server-side barge-in: interim speech during TTS → cancel TTS immediately
          if (shouldHoldBargeInInterimForFinal({
            text: r.text,
            definite: r.definite,
            ttsSpeaking,
            endingInterview,
          })) {
            log.info(`Barge-in detected via ASR (interim: "${r.text.slice(0, 40)}") — cancelling TTS`);
            holdBargeInInterim(r.text);
            cancelTts();
            suppressAsrResults = false;
            generatingResponse = false;
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "interrupt" }));
            }
            continue;
          }

          if (heldBargeInInterimText && r.text.trim()) {
            r.text = mergeAsrSegments(heldBargeInInterimText, r.text);
            clearHeldBargeInInterim();
          }

          // During suppression, defer user finals for flush after reopenAsr.
          // Echo of TTS is mostly definite; we guard on flush. Forward interims
          // only when not playing TTS so live captions work during LLM wait.
          if (suppressAsrResults) {
            const suppressedText = r.text.trim();
            if (
              suppressedText.length >= 2 &&
              !r.definite &&
              !ttsSpeaking &&
              browserWs.readyState === WebSocket.OPEN &&
              !isDuplicateUserFinal(suppressedText) &&
              !shouldIgnoreVolcContinuationFragment(
                suppressedText,
                questionTranscript,
                lastAssistantMessageWallClockMs,
                isZh,
              )
            ) {
              browserWs.send(JSON.stringify({
                type: "asr",
                data: { results: [{ text: suppressedText, definite: r.definite }] },
              }));
            }
            if (r.definite) {
              const suppressedFinal = suppressedText;
              asrAccumulator = "";
              if (suppressedFinal.length >= 2) {
                if (
                  shouldIgnoreVolcContinuationFragment(
                    suppressedFinal,
                    questionTranscript,
                    lastAssistantMessageWallClockMs,
                    isZh,
                  )
                ) {
                  continue;
                }
                const prevPending = pendingUserUtteranceWhileSuppressed.trim();
                const incomingDup = isDuplicateUserFinal(suppressedFinal);
                const sameAsPending =
                  normalizeUserUtteranceKey(suppressedFinal)
                  === normalizeUserUtteranceKey(prevPending);

                // Volc can emit a late duplicate definite for an old turn after a newer utterance
                // was deferred here — blindly overwriting would drop the real follow-up on flush.
                if (
                  prevPending &&
                  incomingDup &&
                  !sameAsPending
                ) {
                  log.info(
                    `Keeping deferred utterance — ignoring stale duplicate: "${suppressedFinal.slice(0, 72)}..."`,
                  );
                } else if (!incomingDup || sameAsPending) {
                  pendingUserUtteranceWhileSuppressed = suppressedFinal;
                } else if (!prevPending) {
                  log.info(
                    `Suppressed ASR final skipped (already answered, nothing deferred): "${suppressedFinal.slice(0, 72)}..."`,
                  );
                }
              }
            }
            continue;
          }

          if (endingInterview) {
            if (r.definite) asrAccumulator = "";
            continue;
          }

          if (!asrSessionFirstSpeechAt && r.text.trim()) {
            asrSessionFirstSpeechAt = Date.now();
          }

          if (pendingAsrFinalText && !r.definite) {
            const { text: merged, changed } = mergePendingAsrInterim(pendingAsrFinalText, r.text);
            if (!changed) {
              log.debug(`ASR duplicate interim while pending: "${merged.slice(0, 80)}"`);
              continue;
            }
            pendingAsrFinalText = merged;
            pendingAsrFinalLastChangedAt = Date.now();
            asrAccumulator = merged;
            sendAsrInterim(merged);
            if (pendingAsrFinalTimer) {
              clearTimeout(pendingAsrFinalTimer);
            }
            const targetDelay = getAsrFinalCoalesceDelay(merged);
            const elapsed = pendingAsrFinalStartedAt
              ? Date.now() - pendingAsrFinalStartedAt
              : 0;
            const quietElapsed = pendingAsrFinalLastChangedAt
              ? Date.now() - pendingAsrFinalLastChangedAt
              : 0;
            const delay = Math.max(0, targetDelay - elapsed, ASR_PENDING_FINAL_QUIET_MS - quietElapsed);
            pendingAsrFinalTimer = setTimeout(() => {
              flushPendingAsrFinal("coalesced");
            }, delay);
            sendAsrPending(merged, delay);
            log.info(`ASR continuation merged: "${merged.slice(0, 80)}"`);
            continue;
          }

          asrAccumulator = pendingAsrFinalText
            ? mergeAsrSegments(pendingAsrFinalText, r.text)
            : r.text;

          if (!r.definite) {
            sendAsrInterim(asrAccumulator);
          }

          if (r.definite) {
            const finalText = asrAccumulator.trim();
            asrAccumulator = "";
            if (finalText && finalText.length >= 2) {
              schedulePendingAsrFinal(finalText, "definite");
            } else {
              clearPendingAsrFinal();
            }
          }
        }
      } catch (err) {
        log.error("ASR parse error:", err);
      }
    });

    asrWs.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() || "";
      log.warn(`ASR WS closed (code=${code}, reason="${reasonStr}")`);
      asrAlive = false;

      // Don't auto-reconnect if we intentionally closed (will reopen later)
      if (asrIntentionalClose) return;
      if (isTransitioning || interviewDone) return;
      if (browserWs.readyState !== WebSocket.OPEN) return;

      autoReconnectAsr().catch((err) => {
        log.error("All ASR reconnect attempts failed:", err instanceof Error ? err.message : err);
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(JSON.stringify({ type: "disconnected" }));
          browserWs.close();
        }
      });
    });

    asrWs.on("error", (err: Error) => {
      log.error(`ASR WS error: ${err.message}`);
    });

    log.info("ASR 2.0 connected");
  }

  const MAX_RECONNECT_ATTEMPTS = 3;
  const RECONNECT_DELAY_MS = 1000;

  async function autoReconnectAsr(): Promise<void> {
    browserWs.send(JSON.stringify({ type: "session_reconnecting" }));

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      if (interviewDone || browserWs.readyState !== WebSocket.OPEN) return;

      const delay = RECONNECT_DELAY_MS * attempt;
      log.info(`ASR auto-reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} (waiting ${delay}ms)...`);
      await new Promise((r) => setTimeout(r, delay));

      if (interviewDone || browserWs.readyState !== WebSocket.OPEN) return;

      try {
        await connectAsr();

        if (!keepAliveInterval) {
          keepAliveInterval = setInterval(() => {
            if (!asrAlive || !asrWs || asrWs.readyState !== WebSocket.OPEN) return;
            asrAudioSeq++;
            asrWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), asrAudioSeq));
          }, 5000);
        }

        browserWs.send(JSON.stringify({ type: "session_reconnected" }));
        browserWs.send(JSON.stringify({ type: "input_ready" }));
        log.info(`ASR auto-reconnect succeeded on attempt ${attempt}`);
        return;
      } catch (err) {
        log.warn(`ASR auto-reconnect attempt ${attempt} failed:`, err instanceof Error ? err.message : err);
      }
    }

    throw new Error("Exhausted all reconnect attempts");
  }

  // ── Initialize ─────────────────────────────────────────────────

  const greeting = currentQuestionIndex > 0
    ? buildResumeGreeting(ctx, currentQuestionIndex)
    : buildGreeting(ctx);

  log.info("Greeting:", greeting.slice(0, 200) + "...");

  try {
    await connectAsr();

    browserWs.send(JSON.stringify({ type: "ready", sessionId: randomUUID() }));

    browserWs.send(
      JSON.stringify({
        type: "question_change",
        questionIndex: currentQuestionIndex,
        totalQuestions: sortedQuestions.length,
      })
    );

    suppressAsrResults = true;
    log.info(`Starting greeting TTS for Q${currentQuestionIndex + 1}`);
    speakAndHandle(greeting, { trackInTranscript: false })
      .then(() => {
        if (
          !interviewDone
          && !isTransitioning
          && browserWs.readyState === WebSocket.OPEN
        ) {
          // Reconnect ASR to clear echo accumulated during greeting TTS
          reopenAsr().catch(log.error);
        }
      })
      .catch(log.error);
  } catch (err) {
    log.error("Failed to initialize:", err);
    browserWs.send(
      JSON.stringify({
        type: "error",
        message: `Connection failed: ${err instanceof Error ? err.message : err}`,
      })
    );
    browserWs.close();
    return;
  }

  // ── Browser message handling ────────────────────────────────────

  browserWs.on("message", (data) => {
    if (!ownsPersistedSession()) return;
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "audio" && msg.data) {
        const pcm = Buffer.from(msg.data, "hex");
        noteIncomingAudioActivity(pcm);
        if (!asrAlive || isTransitioning || !asrWs || asrWs.readyState !== WebSocket.OPEN) return;
        asrAudioSeq++;
        asrWs.send(buildBigModelAudioRequest(pcm, asrAudioSeq));
      } else if (msg.type === "barge_in") {
        if (ttsSpeaking || generatingResponse) {
          log.info("Client barge-in signal received — cancelling TTS");
          cancelTts();
          suppressAsrResults = false;
          generatingResponse = false;
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: "interrupt" }));
          }
        }
      } else if (msg.type === "text_input" && msg.content) {
        const userText = (msg.content as string).trim();
        if (userText && !isTransitioning && !interviewDone) {
          const source = typeof msg.source === "string" ? msg.source : "";
          if (source === "asr_interim_watchdog" && shouldIgnoreAsrInterimReplay(userText)) {
            log.info(`ASR interim replay skipped — stale tail fragment: "${userText.slice(0, 72)}..."`);
            if (browserWs.readyState === WebSocket.OPEN) {
              browserWs.send(JSON.stringify({ type: "interrupt" }));
            }
            return;
          }

          cancelTts();
          browserWs.send(JSON.stringify({ type: "interrupt" }));
          browserWs.send(JSON.stringify({
            type: "asr_ended",
            text: userText,
            ...(source === "chat" ? { source: "chat" } : {}),
          }));
          handleUserUtterance(
            userText,
            source === "chat" ? { isChatInput: true } : undefined,
          ).catch(log.error);
          log.info(`Text input${source ? ` (${source})` : ""}: "${userText.slice(0, 60)}..."`);
        }
      } else if (msg.type === "question_set_update") {
        if (
          ctx.interviewId
          && typeof msg.interviewId === "string"
          && msg.interviewId !== ctx.interviewId
        ) {
          log.warn("Rejected browser question refresh for a different interview");
          return;
        }
        applyDynamicQuestionSet(msg.questions, "browser");
      } else if (msg.type === "next_question") {
        log.info("Browser requested next question");
        const latestEntry = questionTranscript[questionTranscript.length - 1];
        const decision = evaluateTranscriptManualAdvance({
          isTransitioning,
          assistantBusy: generatingResponse || ttsSpeaking || awaitingFinalResponse,
          isRecruitmentInterview: ctx.title.includes("数君招聘"),
          hasCommittedUserTurn: questionTranscript.some((entry) => entry.role === "user"),
          latestTranscriptRole: latestEntry?.role,
          latestAssistantLooksLikeQuestion:
            latestEntry?.role === "assistant" && looksLikeQuestion(latestEntry.text),
        });
        if (!decision.allowed) {
          const message = decision.reason === "assistant_busy"
            ? "请等面试官说完并处理完当前回答后，再进入下一题。"
            : decision.reason === "answer_required"
              ? "请先回答当前正式计分题；没有相关经历也可以如实说明。"
              : "正在切换题目，请稍候。";
          browserWs.send(JSON.stringify({
            type: "transition_rejected",
            direction: "next",
            reason: decision.reason,
            message,
            requestId: typeof msg.requestId === "string" ? msg.requestId : undefined,
            questionIndex: currentQuestionIndex,
            totalQuestions: sortedQuestions.length,
          }));
          return;
        }
        handleTransition().catch(log.error);
      } else if (msg.type === "prev_question") {
        log.info("Browser requested previous question");
        handlePreviousTransition().catch(log.error);
      } else if (msg.type === "text" && msg.content) {
        speakText(msg.content).catch(log.error);
      } else if (msg.type === "code_update") {
        currentCodeContent = (msg.content as string) || "";
        currentCodeLanguage = (msg.language as string) || "plaintext";
      } else if (msg.type === "whiteboard_update") {
        const img = (msg.imageDataUrl as string) || "";
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        if (img && img !== latestWhiteboardImage) {
          latestWhiteboardImage = img;
          whiteboardDirty = true;
          log.info(`Whiteboard update received (${Math.round(img.length / 1024)}KB, dirty=true)`);
        }
        if (requestId) {
          settleWhiteboardSnapshotRequest(requestId, Boolean(img));
        } else if (img) {
          settleAllWhiteboardSnapshotRequests(true);
        }
      } else if (msg.type === "whiteboard_snapshot_unavailable") {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        if (requestId) {
          settleWhiteboardSnapshotRequest(requestId, false);
        }
      } else if (msg.type === "ping") {
        browserWs.send(JSON.stringify({ type: "pong" }));
      }
    } catch (err) {
      log.error("Error handling browser message:", err);
    }
  });

  browserWs.on("close", () => {
    log.info("Browser disconnected");
    if (ctxSessionId && connectionClaim) {
      browserSessionConnections.release(ctxSessionId, connectionClaim.lease);
    }
    const wasFarewellDone = farewellCompleted;
    interviewDone = true;
    clearPendingAsrFinal();
    settleAllWhiteboardSnapshotRequests(false);
    cancelTts();
    if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
    if (dynamicQuestionTimer) clearInterval(dynamicQuestionTimer);
    if (finalResponseTimeout) clearTimeout(finalResponseTimeout);
    if (pendingLastQuestionTimeout) clearTimeout(pendingLastQuestionTimeout);
    if (asrAlive && asrWs && asrWs.readyState === WebSocket.OPEN) {
      try {
        asrAudioSeq++;
        asrWs.send(buildBigModelAudioRequest(Buffer.alloc(0), asrAudioSeq, true));
      } catch { /* ignore */ }
    }
    asrWs?.removeAllListeners();
    asrWs?.close();
    // Non-recruitment sessions retain relay-side completion fallback. A
    // recruitment session must pass the eight-answer save API instead.
    if (wasFarewellDone && ctxSessionId) {
      const record = liveSessions.get(ctxSessionId);
      if (record) record.status = "ended";
      if (!isOprunRecruitmentInterview) {
        void persistSessionStatus(ctxSessionId, "COMPLETED", "closed_after_farewell");
      }
    }
    // 其余情况(答到一半离开)交给断线宽限 + 硬限定时器收尾
  });

  browserWs.on("error", (err) => {
    log.error("Browser WS error:", err.message);
  });

  // ── Keep-alive: send silence periodically for ASR ──────────────

  keepAliveInterval = setInterval(() => {
    if (!asrAlive || !asrWs || asrWs.readyState !== WebSocket.OPEN) return;
    asrAudioSeq++;
    asrWs.send(buildBigModelAudioRequest(Buffer.alloc(3200), asrAudioSeq));
  }, 5000);
}
