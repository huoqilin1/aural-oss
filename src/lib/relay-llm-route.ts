export const RELAY_LLM_PROVIDER_IDS = ["zhipu", "kimi", "deepseek", "doubao"] as const;

export type RelayLlmProviderId = (typeof RELAY_LLM_PROVIDER_IDS)[number];

export interface RelayLlmRoute {
  primary: RelayLlmProviderId;
  fallbacks: RelayLlmProviderId[];
}

export interface RelayLlmProviderSpec {
  id: RelayLlmProviderId;
  label: string;
  relayModel: string;
}

export const RELAY_LLM_PROVIDER_SPECS: Record<
  RelayLlmProviderId,
  RelayLlmProviderSpec
> = {
  doubao: { id: "doubao", label: "豆包", relayModel: "DOUBAO_TEXT_MODEL" },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    relayModel: "deepseek-v4-flash",
  },
  zhipu: {
    id: "zhipu",
    label: "GLM-5.3",
    relayModel: "glm-5.3",
  },
  kimi: {
    id: "kimi",
    label: "Kimi K3",
    relayModel: "kimi-k3",
  },
};

export const DEFAULT_RELAY_LLM_ROUTE: RelayLlmRoute = {
  primary: "zhipu",
  fallbacks: ["kimi", "deepseek", "doubao"],
};

export function recruitGlmOnlyEnabled(): boolean {
  isolatedGlmGateway();
  const mode = process.env.RECRUIT_MODEL_MODE?.trim().toLowerCase();
  if (mode && mode !== "test" && mode !== "production") throw new Error("invalid RECRUIT_MODEL_MODE");
  if (mode === "test") return true;
  if (mode === "production" || process.env.NODE_ENV === "production") return false;
  return process.env.RECRUIT_GLM_ONLY?.trim() === "1";
}

export function recruitTestModelRoutingEnabled(): boolean {
  if (process.env.RECRUIT_MODEL_MODE?.trim().toLowerCase() === "production" || process.env.NODE_ENV === "production") return false;
  return !recruitGlmOnlyEnabled() && process.env.RECRUIT_TEST_MODEL_ROUTING?.trim() === "1";
}

export function isolatedGlmGateway(): { baseUrl: string; model: string } | null {
  const baseUrl = process.env.RECRUIT_TEST_GLM_BASE_URL?.trim().replace(/\/+$/, "") || "";
  const model = process.env.RECRUIT_TEST_GLM_MODEL?.trim() || "";
  if (!baseUrl && !model) return null;
  if (process.env.RECRUIT_MODEL_MODE?.trim().toLowerCase() !== "test") {
    throw new Error("RECRUIT_TEST_GLM configuration requires RECRUIT_MODEL_MODE=test");
  }
  const invalid = () => new Error("RECRUIT_TEST_GLM requires an HTTPS base URL and explicit GLM model");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw invalid(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
      || /[\s\\]/.test(baseUrl) || !/^glm-[A-Za-z0-9_.-]{1,90}$/.test(model)) throw invalid();
  return { baseUrl, model };
}

export function zhipuModel(): string {
  return isolatedGlmGateway()?.model || "glm-5.3";
}

export function zhipuBaseUrl(): string {
  const gateway = isolatedGlmGateway();
  if (gateway) return gateway.baseUrl;
  const base = (process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4").trim().replace(/\/+$/, "");
  if (recruitGlmOnlyEnabled() && base !== "https://open.bigmodel.cn/api/coding/paas/v4") {
    throw new Error("GLM-only mode requires the explicit Coding endpoint; standard API fallback is disabled");
  }
  return base;
}

export function isRelayLlmProviderId(
  value: unknown,
): value is RelayLlmProviderId {
  return typeof value === "string"
    && (RELAY_LLM_PROVIDER_IDS as readonly string[]).includes(value);
}

export function parseRelayLlmRoute(value: unknown): RelayLlmRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isRelayLlmProviderId(record.primary)) return null;
  if (!Array.isArray(record.fallbacks) || record.fallbacks.length > 3) {
    return null;
  }
  if (!record.fallbacks.every(isRelayLlmProviderId)) return null;
  const ordered = [record.primary, ...record.fallbacks];
  if (new Set(ordered).size !== ordered.length) return null;
  return {
    primary: record.primary,
    fallbacks: [...record.fallbacks] as RelayLlmProviderId[],
  };
}

export function relayLlmRouteOrder(
  route: RelayLlmRoute,
): RelayLlmProviderId[] {
  return [route.primary, ...route.fallbacks];
}

export function relayLlmProviderConfigured(
  provider: RelayLlmProviderId,
): boolean {
  if (provider === "doubao") return Boolean((process.env.DOUBAO_TEXT_API_KEY?.trim() || process.env.DOUBAO_LLM_API_KEY?.trim()) &&
    (process.env.DOUBAO_TEXT_MODEL?.trim() || process.env.DOUBAO_LLM_MODEL?.trim()));
  if (provider === "deepseek") return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  if (provider === "zhipu") {
    return Boolean(
      process.env.ZHIPU_API_KEY?.trim() || process.env.GLM_API_KEY?.trim(),
    );
  }
  return Boolean(process.env.KIMI_API_KEY?.trim());
}

export function relayLlmProviderModel(provider: RelayLlmProviderId): string {
  if (provider === "zhipu") return zhipuModel();
  if (provider === "doubao") return process.env.DOUBAO_TEXT_MODEL?.trim() || process.env.DOUBAO_LLM_MODEL?.trim() || "未配置";
  return RELAY_LLM_PROVIDER_SPECS[provider].relayModel;
}
