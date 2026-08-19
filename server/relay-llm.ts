/**
 * Voice-relay text LLM (summaries + interviewer replies).
 * 2026-08-20 王总拍板：质量优先、Token 无上限——默认链 DeepThink 优先，
 * 智谱 GLM 次之，Kimi 兜底（排最后），按已配置的密钥自动裁剪。
 * 显式设置 RELAY_LLM_MODEL 时保持旧的单端点 + 旧回退行为（兼容自管配置）。
 * 注意：语音转写/播报走豆包（volcengine ASR/TTS），不经本模块。
 */

import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../src/lib/logger";

const log = createLogger("relay-llm");

export const RELAY_LLM_PRIMARY_MODEL = "deepseek-v4-pro";
export const RELAY_LLM_FALLBACK_MODEL = "glm-5.3";
const RELAY_LLM_LAST_RESORT_MODEL = "kimi-latest";
const ZHIPU_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

export interface RelayLlmCallMeta {
  stage?: string;
  session?: string;
  question?: number;
}

interface RelayLlmUsage {
  promptTokens: number;
  completionTokens: number;
}

interface RelayLlmEndpoint {
  model: string;
  temperature: number;
  apiKey: string;
  baseUrl: string;
  useGemini: boolean;
}

let cachedChain: RelayLlmEndpoint[] | null = null;
let geminiClient: GoogleGenAI | null = null;
let logged = false;

function parseTemperature(): number {
  const raw = process.env.RELAY_LLM_TEMPERATURE?.trim();
  if (raw === undefined || raw === "") return 0;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 2) {
    log.warn(`Invalid RELAY_LLM_TEMPERATURE="${raw}", using 0`);
    return 0;
  }
  return v;
}

function usesGemini(model: string): boolean {
  const provider = process.env.RELAY_LLM_PROVIDER?.trim().toLowerCase();
  if (provider === "gemini") return true;
  if (provider === "openai") return false;
  return model.toLowerCase().startsWith("gemini");
}

function resolveLegacyPrimaryEndpoint(): RelayLlmEndpoint {
  const model = process.env.RELAY_LLM_MODEL?.trim() || "gemini-3.1-flash-lite";
  const useGemini = usesGemini(model);
  const apiKey = useGemini
    ? (process.env.RELAY_LLM_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || "")
    : (
        process.env.RELAY_LLM_API_KEY?.trim() ||
        process.env.KIMI_API_KEY?.trim() ||
        process.env.MINIMAX_API_KEY?.trim() ||
        ""
      );
  const baseUrl =
    process.env.RELAY_LLM_BASE_URL?.trim() ||
    (process.env.KIMI_API_KEY
      ? process.env.KIMI_BASE_URL?.trim() || KIMI_DEFAULT_BASE_URL
      : process.env.MINIMAX_BASE_URL?.trim() || "https://api.minimaxi.com/v1");

  return {
    model,
    temperature: parseTemperature(),
    apiKey,
    baseUrl,
    useGemini,
  };
}

function resolveFallbackEndpoint(primary: RelayLlmEndpoint): RelayLlmEndpoint | null {
  const model =
    process.env.RELAY_LLM_FALLBACK_MODEL?.trim() || "abab6.5s-chat";
  const apiKey = process.env.RELAY_LLM_FALLBACK_API_KEY?.trim() || process.env.MINIMAX_API_KEY?.trim() || "";
  if (!apiKey) return null;

  const baseUrl =
    process.env.RELAY_LLM_FALLBACK_BASE_URL?.trim() ||
    process.env.MINIMAX_BASE_URL?.trim() ||
    "https://api.minimaxi.com/v1";

  const fallback: RelayLlmEndpoint = {
    model,
    temperature: parseTemperature(),
    apiKey,
    baseUrl,
    useGemini: false,
  };

  if (
    primary.model === fallback.model &&
    primary.baseUrl === fallback.baseUrl &&
    primary.apiKey === fallback.apiKey
  ) {
    return null;
  }

  return fallback;
}

// 按密钥可用性构建默认链：DeepThink → 智谱 GLM → Kimi（王总 2026-08-20 排序）。
function buildProviderChain(): RelayLlmEndpoint[] {
  const temperature = parseTemperature();
  const chain: RelayLlmEndpoint[] = [];

  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (deepseekKey) {
    chain.push({
      model: RELAY_LLM_PRIMARY_MODEL,
      temperature,
      apiKey: deepseekKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL,
      useGemini: false,
    });
  }

  const zhipuKey = process.env.ZHIPU_API_KEY?.trim() || process.env.GLM_API_KEY?.trim();
  if (zhipuKey) {
    chain.push({
      model: RELAY_LLM_FALLBACK_MODEL,
      temperature,
      apiKey: zhipuKey,
      baseUrl: process.env.ZHIPU_BASE_URL?.trim() || ZHIPU_DEFAULT_BASE_URL,
      useGemini: false,
    });
  }

  const kimiKey = process.env.KIMI_API_KEY?.trim();
  if (kimiKey) {
    chain.push({
      model: process.env.KIMI_MODEL?.trim() || RELAY_LLM_LAST_RESORT_MODEL,
      temperature,
      apiKey: kimiKey,
      baseUrl: process.env.KIMI_BASE_URL?.trim() || KIMI_DEFAULT_BASE_URL,
      useGemini: false,
    });
  }

  return chain;
}

function buildEndpointChain(): RelayLlmEndpoint[] {
  if (process.env.RELAY_LLM_MODEL?.trim()) {
    // 显式指定模型：保持旧的单端点 + 旧回退行为。
    const primary = resolveLegacyPrimaryEndpoint();
    const chain = [primary];
    const fallback = resolveFallbackEndpoint(primary);
    if (fallback) chain.push(fallback);
    return chain;
  }
  const providerChain = buildProviderChain();
  if (providerChain.length > 0) return providerChain;
  // 没有任何供应商密钥时保持旧行为（Gemini 默认端点）。
  return [resolveLegacyPrimaryEndpoint()];
}

function getEndpointChain(): RelayLlmEndpoint[] {
  if (!cachedChain) cachedChain = buildEndpointChain();
  return cachedChain;
}

/** @internal */
export function resetRelayLlmCacheForTests(): void {
  cachedChain = null;
  geminiClient = null;
  logged = false;
}

/** Resolved after dotenv loads (see getEndpointChain). */
export function getRelayLlmModel(): string {
  return getEndpointChain()[0]!.model;
}

export function getRelayLlmTemperature(): number {
  return getEndpointChain()[0]!.temperature;
}

export function getRelayLlmFallbackModel(): string | null {
  return getEndpointChain()[1]?.model ?? null;
}

function logConfig(chain: RelayLlmEndpoint[]): void {
  if (logged) return;
  logged = true;

  const primary = chain[0]!;
  if (!primary.apiKey && !chain[1]?.apiKey) {
    log.warn(
      "Relay LLM: no API key configured (set GEMINI_API_KEY, MINIMAX_API_KEY, or RELAY_LLM_API_KEY)",
    );
    return;
  }

  if (primary.apiKey) {
    const backend = primary.useGemini ? "gemini" : primary.baseUrl;
    log.info(
      `Relay LLM: ${primary.model} @ ${backend} (temperature=${primary.temperature})`,
    );
  }

  const fallback = chain[1];
  if (fallback?.apiKey) {
    log.info(
      `Relay LLM fallback: ${fallback.model} @ ${fallback.baseUrl} (temperature=${fallback.temperature})`,
    );
  }
}

/** Call once after dotenv loads (e.g. voice-relay startup). */
export function logRelayLlmStartup(): void {
  logConfig(getEndpointChain());
}

function getGeminiClient(apiKey: string): GoogleGenAI {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

async function callGemini(
  endpoint: RelayLlmEndpoint,
  prompt: string,
  maxTokens: number,
): Promise<{ text: string; usage?: RelayLlmUsage }> {
  const client = getGeminiClient(endpoint.apiKey);
  const stream = await client.models.generateContentStream({
    model: endpoint.model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: endpoint.temperature,
      maxOutputTokens: maxTokens,
    },
  });

  let text = "";
  let usage: RelayLlmUsage | undefined;
  for await (const chunk of stream) {
    if (chunk.text) text += chunk.text;
    const meta = chunk.usageMetadata;
    if (meta) {
      usage = {
        promptTokens: meta.promptTokenCount ?? 0,
        completionTokens: meta.candidatesTokenCount ?? 0,
      };
    }
  }
  return { text: text.trim(), usage };
}

async function callOpenAICompatible(
  endpoint: RelayLlmEndpoint,
  prompt: string,
  maxTokens: number,
): Promise<{ text: string; usage?: RelayLlmUsage }> {
  const reqBody: Record<string, unknown> = {
    model: endpoint.model,
    messages: [{ role: "user", content: prompt }],
    temperature: endpoint.temperature,
    max_tokens: maxTokens,
  };
  // 关思考(GLM/deepseek 支持):RELAY_LLM_DISABLE_THINKING=1 时禁用推理,秒回省成本。
  // 注意:DeepThink 优先策略下不要设置此变量(2026-08-20 王总要的是深思考质量)。
  if (process.env.RELAY_LLM_DISABLE_THINKING?.trim() === "1") {
    reqBody.thinking = { type: "disabled" };
  }
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`LLM API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const usage = data.usage
    ? {
        promptTokens: Number(data.usage.prompt_tokens ?? 0) || 0,
        completionTokens: Number(data.usage.completion_tokens ?? 0) || 0,
      }
    : undefined;
  return { text: data.choices?.[0]?.message?.content?.trim() || "", usage };
}

async function callEndpoint(
  endpoint: RelayLlmEndpoint,
  prompt: string,
  maxTokens: number,
): Promise<{ text: string; usage?: RelayLlmUsage }> {
  if (!endpoint.apiKey) {
    throw new Error(`No API key for relay model ${endpoint.model}`);
  }
  return endpoint.useGemini
    ? callGemini(endpoint, prompt, maxTokens)
    : callOpenAICompatible(endpoint, prompt, maxTokens);
}

export async function callRelayLLM(
  prompt: string,
  maxTokens = 150,
  meta?: RelayLlmCallMeta,
): Promise<string> {
  const chain = getEndpointChain();
  logConfig(chain);

  const configured = chain.filter((e) => e.apiKey);
  if (configured.length === 0) {
    return "";
  }

  const startMs = Date.now();
  let lastError: unknown;

  for (let i = 0; i < configured.length; i++) {
    const endpoint = configured[i]!;
    try {
      const { text, usage } = await callEndpoint(endpoint, prompt, maxTokens);
      const latencyMs = Date.now() - startMs;
      // Token 分类账：每笔调用一行，stage 区分环节（turn/summarize/generate…），
      // 供"每场消耗多少、花在哪"的看板汇总。
      log.info(
        `relay-llm usage: stage=${meta?.stage ?? "unlabeled"} session=${meta?.session ?? "-"} ` +
        `q=${meta?.question ?? "-"} model=${endpoint.model} ` +
        `tokens_in=${usage?.promptTokens ?? "?"} tokens_out=${usage?.completionTokens ?? "?"} ` +
        `latency_ms=${latencyMs}${i > 0 ? ` recovered_from=${configured[0]!.model}` : ""}`,
      );
      return text;
    } catch (err) {
      lastError = err;
      const next = configured[i + 1];
      if (next) {
        log.warn(
          `Relay LLM failed for ${endpoint.model}, falling back to ${next.model}`,
          err,
        );
      }
    }
  }

  log.error("Relay LLM failed on all configured models", lastError);
  throw lastError ?? new Error("Relay LLM failed");
}
