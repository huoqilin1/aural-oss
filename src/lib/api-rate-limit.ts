const windowMs = 60_000;
// 每调用方每分钟上限。HR 招聘(OpRun HR)同时间面 20~40 场时,
// 准备阶段 + 语音进度同步的峰值约 200~250 次/分钟,留 2 倍余量。
const maxRequests = 600;

const hits = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  hits.forEach((entry, key) => {
    if (entry.resetAt <= now) hits.delete(key);
  });
}, 60_000).unref();

export function checkRateLimit(identifier: string): Response | null {
  const now = Date.now();
  let entry = hits.get(identifier);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 1, resetAt: now + windowMs };
    hits.set(identifier, entry);
    return null;
  }

  entry.count++;

  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return Response.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: `Too many requests. Retry after ${retryAfter}s.`,
          retry_after: retryAfter,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(entry.resetAt / 1000)),
        },
      },
    );
  }

  return null;
}
