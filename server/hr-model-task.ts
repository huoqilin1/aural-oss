import { createHmac, createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { UsageOutbox } from "./hr-model-usage-outbox";
import { runtimeStateDirectory } from "./voice-online-state";
import { parseRelayLlmRoute, type RelayLlmRoute } from "../src/lib/relay-llm-route";

export type TaskIdentity = { interview_id?: string; session_id?: string; stage: string };
type Control = { success: boolean; task_key: string; round: number; state: string; route: RelayLlmRoute };
type Attempt = { provider: string; model: string; state: string; error: string };
type Event = TaskIdentity & { id: string; action: "failure" | "success"; round: number; attempts?: Attempt[] };
export class HrTaskHalted extends Error {
  readonly code = "all_models_failed";
  constructor() { super("all_models_failed"); }
}

async function control(body: unknown): Promise<Control> {
  const rawUrl = process.env.HR_MODEL_CONTROL_URL?.trim();
  const secret = process.env.HR_MODEL_CONTROL_SECRET?.trim();
  if (!rawUrl || !secret) throw new Error("HR_model_task_configuration_missing");
  const url = new URL(rawUrl);
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/model-policy") ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("HR_model_task_configuration_invalid");
  }
  url.pathname = url.pathname.replace(/model-policy$/, "model-task");
  const timestamp = String(Math.floor(Date.now() / 1000));
  // Older queued failures used spaces in the known HTTP error code. Normalize
  // only that fixed code so the existing durable event can pass HR validation.
  const event = body as Partial<Event>;
  const payload = event.action === "failure" && Array.isArray(event.attempts)
    ? { ...event, attempts: event.attempts.map(attempt => ({ ...attempt,
        error: attempt.error.replace(/^LLM API ([1-5][0-9]{2})$/, "http_$1") })) }
    : body;
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${timestamp}\nPOST\n${url.pathname}\n${raw}`).digest("hex");
  const response = await fetch(url, { method: "POST", body: raw, redirect: "error", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-HR-Model-Timestamp": timestamp, "X-HR-Model-Signature": signature }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("HR_model_task_control_unavailable");
  const data = await response.json();
  const route = parseRelayLlmRoute(data.route);
  if (!data.success || !route || !/^aural:\d+$/.test(data.task_key) || !Number.isSafeInteger(data.round) || data.round < 1 || !["active", "halted"].includes(data.state)) {
    throw new Error("HR_model_task_control_invalid");
  }
  return { ...data, route };
}

let outbox: UsageOutbox<Event> | null = null;
let outboxRoot: string | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;
function eventOutbox(root: string) {
  if (!outbox || outboxRoot !== root) {
    outboxRoot = root;
    outbox = new UsageOutbox<Event>(join(root, "model-task-events"), async event => {
      const result = await control(event);
      if (result.round < event.round) throw new Error("HR_model_task_ack_mismatch");
    });
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = setInterval(() => { void outbox?.flush().catch(() => {}); }, 5000);
    drainTimer.unref();
  }
  return outbox;
}

const running = new Set<string>();
export async function runHrModelTask<T>(identity: TaskIdentity, operation: (route: RelayLlmRoute) => Promise<T>): Promise<T> {
  const root = runtimeStateDirectory();
  if (!root) throw new Error("AURAL_RUNTIME_STATE_DIR_required");
  const events = eventOutbox(root);
  await events.ready();
  void events.flush().catch(() => {});
  const state = await control({ ...identity, action: "begin" });
  const key = `${state.task_key}:${state.round}`;
  const operationKey = `${key}:${identity.stage}`;
  const haltDirectory = join(root, "model-task-halts");
  await mkdir(haltDirectory, { recursive: true, mode: 0o700 });
  const marker = join(haltDirectory, createHash("sha256").update(key).digest("hex") + ".json");
  let localHalt = false;
  try {
    const saved = JSON.parse(await readFile(marker, "utf8")) as Event;
    localHalt = true;
    await events.enqueue(saved);
    void events.flush().catch(() => {});
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (state.state === "halted" || localHalt) throw new HrTaskHalted();
  if (running.has(operationKey)) throw new Error("HR_model_task_busy");
  running.add(operationKey);
  try {
    const result = await operation(state.route);
    await events.enqueue({ ...identity, id: randomUUID(), action: "success", round: state.round });
    void events.flush().catch(() => {});
    return result;
  } catch (error) {
    const attempts = (error as { attempts?: Attempt[] })?.attempts;
    const boundedOverload = state.route.primary === "zhipu" && state.route.fallbacks.length === 0
      && Array.isArray(attempts) && attempts.length >= 1 && attempts.length <= 3
      && attempts.every(item => item.provider === "zhipu" && item.model === "glm-5.3")
      && attempts.slice(0, -1).every(item => item.error === "http_429_code_1305");
    if (Array.isArray(attempts) && (boundedOverload || attempts.length === state.route.fallbacks.length + 1)) {
      const event: Event = { ...identity, id: randomUUID(), action: "failure", round: state.round, attempts };
      // Stop locally even if the network fails before HR acknowledges the event.
      const temporary = join(haltDirectory, randomUUID() + ".tmp");
      await writeFile(temporary, JSON.stringify(event), { flag: "wx", mode: 0o600 });
      try {
        try { await link(temporary, marker); }
        catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError; }
      } finally { await unlink(temporary); }
      await events.enqueue(event);
      void events.flush().catch(() => {});
    }
    throw error;
  } finally {
    running.delete(operationKey);
  }
}
