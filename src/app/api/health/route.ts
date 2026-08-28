import { releaseRevision } from "@/lib/release-status";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    status: "ok",
    service: "aural",
    revision: releaseRevision(),
  });
}
