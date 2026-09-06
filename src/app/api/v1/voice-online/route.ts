import { isAuthError, validateApiKey } from "@/lib/api-key-auth";
import { readVoiceOnline } from "../../../../../server/voice-online-state";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await validateApiKey(request);
  if (isAuthError(auth)) return auth;
  return Response.json({ data: await readVoiceOnline() });
}
