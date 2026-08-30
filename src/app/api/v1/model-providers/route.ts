import {
  isAuthError,
  validateApiKey,
} from "@/lib/api-key-auth";
import {
  RELAY_LLM_PROVIDER_IDS,
  RELAY_LLM_PROVIDER_SPECS,
  relayLlmProviderConfigured,
} from "@/lib/relay-llm-route";

export async function GET(request: Request) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;

  return Response.json({
    data: RELAY_LLM_PROVIDER_IDS.map((id) => ({
      id,
      label: RELAY_LLM_PROVIDER_SPECS[id].label,
      model: RELAY_LLM_PROVIDER_SPECS[id].relayModel,
      configured: relayLlmProviderConfigured(id),
    })),
  });
}
