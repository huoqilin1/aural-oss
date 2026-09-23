import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

const log = createLogger("api/session/upload");

/**
 * Upload a file (audio recording or screenshot) to Supabase Storage.
 *
 * Expects multipart FormData with:
 *   - file: Blob/File
 *   - sessionId: string
 *   - type: "recording" | "screenshot"
 *   - filename: string (optional, used as the storage path suffix)
 */
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as Blob | null;
    const sessionId = formData.get("sessionId") as string | null;
    const type = formData.get("type") as string | null;
    const filename = formData.get("filename") as string | null;
    const durationValue = formData.get("audioDuration");
    const audioDuration = durationValue == null ? undefined : Number(durationValue);

    if (!file || !sessionId || !type) {
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
    if (audioDuration !== undefined && (!Number.isFinite(audioDuration) || audioDuration < 0)) {
      return NextResponse.json({ error: "Invalid audio duration" }, { status: 400 });
    }
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("sessions").select("id").eq("id", sessionId).maybeSingle();
    if (sessionError) return NextResponse.json({ error: "Session lookup failed" }, { status: 500 });
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const bucket = type === "recording" ? "recordings" : "screenshots";
    const defaultExt = type === "recording"
      ? (file.type?.includes("mp4") || file.type?.includes("m4a") ? "m4a" : "webm")
      : "jpg";
    const buffer = Buffer.from(await file.arrayBuffer());
    // Stable content-addressed recording keys make a lost response safely retryable.
    const storagePath = `${sessionId}/${type === "recording"
      ? `recording-${createHash("sha256").update(buffer).digest("hex")}.${defaultExt}`
      : filename || `${Date.now()}.${defaultExt}`}`;

    const defaultContentType = type === "recording"
      ? (file.type?.includes("mp4") ? "audio/mp4" : "audio/webm")
      : "image/jpeg";

    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, buffer, {
        contentType: file.type || defaultContentType,
        upsert: false,
      });

    if (uploadError) {
      // Only reuse an existing recording after verifying its complete content.
      const { data: existing } = type === "recording"
        ? await supabaseAdmin.storage.from(bucket).download(storagePath)
        : { data: null };
      const matches = existing && Buffer.from(await existing.arrayBuffer()).equals(buffer);
      if (!matches) {
        log.error("Storage error:", bucket, uploadError);
        return NextResponse.json(
          { error: "Recording upload failed" },
          { status: 500 },
        );
      }
    }

    const { data: signedData, error: signedError } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365); // 1 year

    if (signedError || !signedData?.signedUrl) {
      log.error("Signed URL error:", bucket, signedError);
      return NextResponse.json(
        { error: "Failed to generate signed URL" },
        { status: 500 },
      );
    }

    if (type === "recording") {
      const { data: linked, error: linkError } = await supabaseAdmin.from("sessions")
        .update({ audioRecordingUrl: signedData.signedUrl,
          ...(audioDuration === undefined ? {} : { audioDuration }) })
        .eq("id", sessionId).select("id").maybeSingle();
      if (linkError || !linked) {
        return NextResponse.json({ error: "Recording link failed" }, { status: 500 });
      }
    }
    return NextResponse.json({
      url: signedData.signedUrl,
      path: storagePath,
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
