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
  return !recruitTestModelRoutingEnabled() && process.env.RECRUIT_GLM_ONLY?.trim() === "1";
}

export function recruitTestModelRoutingEnabled(): boolean {
  return process.env.RECRUIT_TEST_MODEL_ROUTING?.trim() === "1";
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
  if (!Array.isArray(record.fallbacks) || ![0, 2, 3].includes(record.fallbacks.length)) {
    return null;
  }
  if (record.fallbacks.length === 0 && record.primary !== "zhipu") return null;
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
  if (provider === "doubao") return process.env.DOUBAO_TEXT_MODEL?.trim() || process.env.DOUBAO_LLM_MODEL?.trim() || "未配置";
  return RELAY_LLM_PROVIDER_SPECS[provider].relayModel;
}
