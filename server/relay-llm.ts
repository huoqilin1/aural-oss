/**
 * Voice-relay text LLM (summaries + interviewer replies).
 * 2026-08-20 王总拍板：质量优先、Token 无上限——默认链 DeepThink 优先，
 * 智谱 GLM 次之，Kimi 兜底（排最后），按已配置的密钥自动裁剪。
 * 显式设置 RELAY_LLM_MODEL 时保持旧的单端点 + 旧回退行为（兼容自管配置）。
 * 注意：语音转写/播报走豆包（volcengine ASR/TTS），不经本模块。
 */

import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../src/lib/logger";
import {
  type RelayLlmProviderId,
  type RelayLlmRoute,
  relayLlmRouteOrder,
} from "../src/lib/relay-llm-route";

const log = createLogger("relay-llm");

// 模型策略（王总 2026-08-20 定稿，两条线并行）：
// - 前台对话线（本模块）：deepseek-v4-flash 快模型，现场问答秒级回应。
// - 后台出题线（generate-questions 路由）：deepseek-v4-pro 深思考模型，
//   候选人答开场题时后台慢慢生成简历+岗位融合题。
// - DeepSeek 档位写死（快/深两档不得互换漂移）；GLM / Kimi 追各家最新版。
// - 所有 ID 可环境变量覆盖（DEEPSEEK_MODEL / ZHIPU_MODEL / KIMI_MODEL /
//   RECRUIT_GENERATOR_MODEL），升级改 env 即生效。核查日期 2026-08-20。
function deepseekRelayModel(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
}
function zhipuRelayModel(): string {
  return process.env.ZHIPU_MODEL?.trim() || process.env.GLM_MODEL?.trim() || "glm-5.3";
}
function kimiRelayModel(): string {
  const configured = process.env.KIMI_MODEL?.trim();
  return !configured || configured === "kimi-latest" ? "kimi-k3" : configured;
}
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
const loggedRoutes = new Set<string>();
const endpointCooldowns = new Map<string, number>();
let readinessProbe:
  | { key: string; expiresAt: number; promise: Promise<void> }
  | null = null;

const READINESS_CACHE_MS = 60_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 30_000;
const NON_RETRYABLE_FAILURE_COOLDOWN_MS = 15 * 60_000;

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
  const configuredModel = process.env.RELAY_LLM_MODEL?.trim() || "gemini-3.1-flash-lite";
  const model = configuredModel === "kimi-latest" ? "kimi-k3" : configuredModel;
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
  const configuredModel =
    process.env.RELAY_LLM_FALLBACK_MODEL?.trim() || "abab6.5s-chat";
  const apiKey = process.env.RELAY_LLM_FALLBACK_API_KEY?.trim() || process.env.MINIMAX_API_KEY?.trim() || "";
  if (!apiKey) return null;

  const baseUrl =
    process.env.RELAY_LLM_FALLBACK_BASE_URL?.trim() ||
    process.env.MINIMAX_BASE_URL?.trim() ||
    "https://api.minimaxi.com/v1";
  const model =
    configuredModel === "kimi-latest" && /moonshot\.(?:cn|ai|com)/i.test(baseUrl)
      ? "kimi-k3"
      : configuredModel;

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
function providerEndpoint(
  provider: RelayLlmProviderId,
  temperature: number,
): RelayLlmEndpoint | null {
  if (provider === "deepseek") {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    return apiKey ? {
      model: deepseekRelayModel(),
      temperature,
      apiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL,
      useGemini: false,
    } : null;
  }
  if (provider === "zhipu") {
    const apiKey = process.env.ZHIPU_API_KEY?.trim() || process.env.GLM_API_KEY?.trim();
    return apiKey ? {
      model: zhipuRelayModel(),
      temperature,
      apiKey,
      baseUrl: process.env.ZHIPU_BASE_URL?.trim() || ZHIPU_DEFAULT_BASE_URL,
      useGemini: false,
    } : null;
  }
  const apiKey = process.env.KIMI_API_KEY?.trim();
  return apiKey ? {
    model: kimiRelayModel(),
    temperature,
    apiKey,
    baseUrl: process.env.KIMI_BASE_URL?.trim() || KIMI_DEFAULT_BASE_URL,
    useGemini: false,
  } : null;
}

function buildProviderChain(route?: RelayLlmRoute): RelayLlmEndpoint[] {
  const temperature = parseTemperature();
  const order: RelayLlmProviderId[] = route
    ? relayLlmRouteOrder(route)
    : ["deepseek", "zhipu", "kimi"];
  return order.flatMap((provider) => {
    const endpoint = providerEndpoint(provider, temperature);
    return endpoint ? [endpoint] : [];
  });
}

function buildEndpointChain(route?: RelayLlmRoute): RelayLlmEndpoint[] {
  if (!route && process.env.RELAY_LLM_MODEL?.trim()) {
    // 显式指定模型：保持旧的单端点 + 旧回退行为。
    const primary = resolveLegacyPrimaryEndpoint();
    const chain = [primary];
    const fallback = resolveFallbackEndpoint(primary);
    if (fallback) chain.push(fallback);
    return chain;
  }
  const providerChain = buildProviderChain(route);
  if (providerChain.length > 0) return providerChain;
  // A route selected by HR is authoritative. Never escape to a legacy fourth
  // provider when every selected provider is unconfigured.
  if (route) return [];
  // 没有任何供应商密钥时保持旧行为（Gemini 默认端点）。
  return [resolveLegacyPrimaryEndpoint()];
}

function getEndpointChain(route?: RelayLlmRoute): RelayLlmEndpoint[] {
  if (route) return buildEndpointChain(route);
  if (!cachedChain) cachedChain = buildEndpointChain();
  return cachedChain;
}

/** @internal */
export function resetRelayLlmCacheForTests(): void {
  cachedChain = null;
  geminiClient = null;
  loggedRoutes.clear();
  endpointCooldowns.clear();
  readinessProbe = null;
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
  const routeKey = chain.map(endpointKey).join(",");
  if (loggedRoutes.has(routeKey)) return;
  loggedRoutes.add(routeKey);

  if (chain.length === 0) {
    log.warn("Relay LLM: no API key configured for the HR-selected provider route");
    return;
  }

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
  maxTokens?: number,
): Promise<{ text: string; usage?: RelayLlmUsage }> {
  const client = getGeminiClient(endpoint.apiKey);
  const stream = await client.models.generateContentStream({
    model: endpoint.model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: endpoint.temperature,
      ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
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
  maxTokens?: number,
): Promise<{ text: string; usage?: RelayLlmUsage }> {
  // 2026-08-20 王总指令：Token 无上限——不传 max_tokens，让模型自然收尾。
  const reqBody: Record<string, unknown> = {
    model: endpoint.model,
    messages: [{ role: "user", content: prompt }],
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };
  // Kimi K3 rejects the legacy `temperature` field. The official Kimi
  // Chat Completions quickstart omits it, while DeepSeek/GLM/MiniMax keep
  // accepting the configured value.
  if (!endpoint.model.toLowerCase().startsWith("kimi-")) {
    reqBody.temperature = endpoint.temperature;
  }
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

function endpointKey(endpoint: RelayLlmEndpoint): string {
  return `${endpoint.baseUrl}|${endpoint.model}`;
}

function failureCooldownMs(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return /LLM API (?:400|401|402|403|404)\b/.test(message)
    ? NON_RETRYABLE_FAILURE_COOLDOWN_MS
    : TRANSIENT_FAILURE_COOLDOWN_MS;
}

async function callEndpoint(
  endpoint: RelayLlmEndpoint,
  prompt: string,
  maxTokens?: number,
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
  maxTokens?: number,
  meta?: RelayLlmCallMeta,
  route?: RelayLlmRoute,
): Promise<string> {
  const chain = getEndpointChain(route);
  logConfig(chain);

  const configured = chain.filter((e) => e.apiKey);
  if (configured.length === 0) {
    return "";
  }

  const now = Date.now();
  const available = configured.filter(
    (endpoint) => (endpointCooldowns.get(endpointKey(endpoint)) ?? 0) <= now,
  );
  // If every provider is cooling down, retry the chain so recovery is not
  // permanently blocked. Otherwise skip known-bad providers immediately.
  const candidates = available.length > 0 ? available : configured;

  const startMs = Date.now();
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const endpoint = candidates[i]!;
    try {
      const { text, usage } = await callEndpoint(endpoint, prompt, maxTokens);
      endpointCooldowns.delete(endpointKey(endpoint));
      const latencyMs = Date.now() - startMs;
      // Token 分类账：每笔调用一行，stage 区分环节（turn/summarize/generate…），
      // 供"每场消耗多少、花在哪"的看板汇总。
      log.info(
        `relay-llm usage: stage=${meta?.stage ?? "unlabeled"} session=${meta?.session ?? "-"} ` +
        `q=${meta?.question ?? "-"} model=${endpoint.model} ` +
        `tokens_in=${usage?.promptTokens ?? "?"} tokens_out=${usage?.completionTokens ?? "?"} ` +
        `latency_ms=${latencyMs}${i > 0 ? ` recovered_from=${candidates[0]!.model}` : ""}`,
      );
      return text;
    } catch (err) {
      lastError = err;
      endpointCooldowns.set(
        endpointKey(endpoint),
        Date.now() + failureCooldownMs(err),
      );
      const next = candidates[i + 1];
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

export async function assertRelayLlmReady(options?: {
  force?: boolean;
  route?: RelayLlmRoute;
}): Promise<void> {
  const now = Date.now();
  const routeKey = options?.route
    ? relayLlmRouteOrder(options.route).join(",")
    : "default";
  if (
    !options?.force
    && readinessProbe
    && readinessProbe.key === routeKey
    && readinessProbe.expiresAt > now
  ) {
    return readinessProbe.promise;
  }

  const promise = callRelayLLM(
    "Reply with exactly READY.",
    undefined,
    { stage: "readiness_probe" },
    options?.route,
  ).then((text) => {
    if (!text.trim()) throw new Error("Relay LLM readiness probe returned no text");
  });
  readinessProbe = {
    key: routeKey,
    expiresAt: now + READINESS_CACHE_MS,
    promise,
  };
  try {
    await promise;
  } catch (error) {
    if (readinessProbe?.promise === promise) readinessProbe = null;
    throw error;
  }
}
