import { createHmac, randomUUID } from "node:crypto";

type Admission = { success: boolean; granted: boolean };

async function control(action: string, requestId: string, priority = 0): Promise<Admission> {
  const rawUrl = process.env.HR_MODEL_CONTROL_URL?.trim();
  const secret = process.env.HR_MODEL_CONTROL_SECRET?.trim();
  if (!rawUrl || !secret) throw new Error("GLM_capacity_configuration_missing");
  const url = new URL(rawUrl);
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/model-policy") ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("GLM_capacity_configuration_invalid");
  }
  url.pathname = url.pathname.replace(/model-policy$/, "model-capacity");
  const raw = JSON.stringify({ action, request_id: requestId, priority });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}\nPOST\n${url.pathname}\n${raw}`).digest("hex");
  const response = await fetch(url, { method: "POST", body: raw, redirect: "error", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-HR-Model-Timestamp": timestamp, "X-HR-Model-Signature": signature },
    signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("GLM_capacity_control_unavailable");
  const data = await response.json();
  if (data.success !== true || typeof data.granted !== "boolean") throw new Error("GLM_capacity_control_invalid");
  return data;
}

export async function acquireGlmSlot(priority: -1 | 0 | 1 = -1): Promise<{ signal: AbortSignal; release: () => Promise<void> }> {
  const controller = new AbortController();
  if (process.env.GLM_SHARED_CAPACITY_ENABLED?.trim() !== "1") return { signal: controller.signal, release: async () => {} };
  const requestId = randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    controller.abort();
    if (heartbeat) clearInterval(heartbeat);
    await pending;
    await control("release", requestId).catch(() => {
      console.warn("GLM_capacity_release_failed; lease expires automatically");
    });
  };
  try {
    const deadline = Date.now() + 900_000;
    while (!(await control("acquire", requestId, priority)).granted) {
      if (Date.now() >= deadline) throw new Error("GLM_capacity_wait_timeout");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    heartbeat = setInterval(() => {
      pending = control("renew", requestId).then(result => {
        if (!result.granted) controller.abort(new Error("GLM_capacity_lease_lost"));
      }).catch(() => { controller.abort(new Error("GLM_capacity_lease_lost")); });
    }, 20_000);
    heartbeat.unref();
    return { signal: controller.signal, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function withGlmSlot<T>(operation: (signal: AbortSignal) => Promise<T>, priority: -1 | 0 | 1 = -1): Promise<T> {
  const lease = await acquireGlmSlot(priority);
  try {
    const result = await operation(lease.signal);
    lease.signal.throwIfAborted();
    return result;
  } finally { await lease.release(); }
}
