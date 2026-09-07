import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const instance = randomUUID();
export function runtimeStateDirectory(): string | null {
  const value = process.env.AURAL_RUNTIME_STATE_DIR?.trim();
  return value && isAbsolute(value) ? value : null;
}

export async function publishVoiceOnline(ids: string[], directory = runtimeStateDirectory(), at = Date.now()) {
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `voice-online-${instance}.json`);
  const temporary = target + ".tmp";
  await writeFile(temporary, JSON.stringify({ at,
    sessions: Array.from(new Set(ids.map(id => createHash("sha256").update(id).digest("hex")))),
  }), { mode: 0o600 });
  await rename(temporary, target);
}

export async function readVoiceOnline(directory = runtimeStateDirectory(), now = Date.now(), sessionId?: string) {
  const unknown = { status: "unknown", count: null, observed_at: null, ...(sessionId ? { connected: null } : {}) };
  if (!directory) return unknown;
  try {
    const files = (await readdir(directory)).filter(name => /^voice-online-[a-f0-9-]+\.json$/.test(name));
    const sessions = new Set<string>();
    let observed = 0;
    for (const name of files) {
      const row = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (!Number.isFinite(row.at) || row.at > now || now - row.at > 45_000) continue;
      if (!Array.isArray(row.sessions) || !row.sessions.every((id: unknown) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))) return unknown;
      observed = Math.max(observed, row.at);
      for (const id of row.sessions) sessions.add(id);
    }
    return observed ? { status: "fresh", count: sessions.size, observed_at: new Date(observed).toISOString(),
      ...(sessionId ? { connected: sessions.has(createHash("sha256").update(sessionId).digest("hex")) } : {}) } : unknown;
  } catch {
    return unknown;
  }
}
