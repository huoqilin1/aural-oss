import {
  type RelayLlmRoute,
  parseRelayLlmRoute,
} from "../src/lib/relay-llm-route";
import type { SupabaseClient } from "@supabase/supabase-js";

export function relayLlmRouteFromInterview(
  interview: Record<string, unknown> | null | undefined,
): RelayLlmRoute | undefined {
  if (!interview) return undefined;
  const branding = interview.customBranding;
  if (branding && typeof branding === "object" && !Array.isArray(branding)) {
    const parsed = parseRelayLlmRoute(
      (branding as Record<string, unknown>).oprunRelayLlmRoute,
    );
    if (parsed) return parsed;
  }
  return undefined;
}

export async function loadInterviewRelayLlmRoute(
  client: SupabaseClient | null,
  interviewId?: string,
): Promise<RelayLlmRoute | undefined> {
  if (!client || !interviewId) return undefined;
  const { data, error } = await client
    .from("interviews")
    .select("customBranding")
    .eq("id", interviewId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message || "interview model route lookup failed");
  }
  return relayLlmRouteFromInterview(data);
}
