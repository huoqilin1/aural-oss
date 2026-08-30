export const RELAY_LLM_PROVIDER_IDS = ["deepseek", "zhipu", "kimi"] as const;

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
  primary: "deepseek",
  fallbacks: ["zhipu", "kimi"],
};

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
  if (!Array.isArray(record.fallbacks) || record.fallbacks.length !== 2) {
    return null;
  }
  if (!record.fallbacks.every(isRelayLlmProviderId)) return null;
  const ordered = [record.primary, ...record.fallbacks];
  if (new Set(ordered).size !== RELAY_LLM_PROVIDER_IDS.length) return null;
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
  if (provider === "deepseek") return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  if (provider === "zhipu") {
    return Boolean(
      process.env.ZHIPU_API_KEY?.trim() || process.env.GLM_API_KEY?.trim(),
    );
  }
  return Boolean(process.env.KIMI_API_KEY?.trim());
}
