import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import {storeMediaObject} from '@/lib/voice/media-object-storage';
import {sessionAccessResponse} from '@/server/session-access-http';

const log = createLogger("api/session/upload");

/**
 * Upload a file (audio recording or screenshot) to Supabase Storage.
 *
 * Expects multipart FormData with:
 *   - file: Blob/File
 *   - sessionId: string
 *   - type: "recording" | "screenshot"
 *   - filename: optional legacy field; object paths use a server-computed content hash
 */
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as Blob | null;
    const sessionId = formData.get("sessionId") as string | null;
    const type = formData.get("type") as string | null;

    if (!(file instanceof Blob) || !file.size || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId) || !type) {
      return NextResponse.json(
        { error: "Missing required fields: file, sessionId, type" },
        { status: 400 },
      );
    }

    if (type !== "recording" && type !== "screenshot") {
      return NextResponse.json(
        { error: 'type must be "recording" or "screenshot"' },
        { status: 400 },
      );
    }

    const bucket = type === "recording" ? "recordings" : "screenshots";
    const denied=await sessionAccessResponse(sessionId);
    if(denied)return denied;
    const {data: session, error: sessionError} = await supabaseAdmin.from('sessions').select('id').eq('id',sessionId).maybeSingle();
    if (sessionError) return NextResponse.json({error:'Unable to verify recording session'},{status:500});
    if (!session) return NextResponse.json({error:'Recording session not found'},{status:404});
    const defaultExt = type === "recording"
      ? (file.type?.includes("mp4") || file.type?.includes("m4a") ? "m4a" : "webm")
      : "jpg";

    const buffer = Buffer.from(await file.arrayBuffer());

    const defaultContentType = type === "recording"
      ? (file.type?.includes("mp4") ? "audio/mp4" : "audio/webm")
      : "image/jpeg";

    const stored = await storeMediaObject(supabaseAdmin.storage.from(bucket),{
      sessionId,bytes:buffer,contentType:file.type || defaultContentType,extension:defaultExt,
    });

    return NextResponse.json({
      ...stored,
      bucket,
    });
  } catch (err) {
    log.error("Unexpected error:", err);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 },
    );
  }
}
