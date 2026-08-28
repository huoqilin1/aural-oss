import { releaseRevision } from "@/lib/release-status";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    service: "aural",
    revision: releaseRevision(),
  });
}
