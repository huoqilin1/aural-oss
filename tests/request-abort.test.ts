import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import http from "node:http";
import test from "node:test";
import { requestAbortScope } from "../server/request-abort";

test("request cancellation preserves the reason and removes source listeners", () => {
  const source = new AbortController();
  const reason = new Error("lease_lost");
  const scope = requestAbortScope([source.signal]);
  assert.equal(getEventListeners(source.signal, "abort").length, 1);
  source.abort(reason);
  assert.equal(scope.signal.reason, reason);
  scope.dispose();
  assert.equal(getEventListeners(source.signal, "abort").length, 0);
  const alreadyAborted = requestAbortScope([source.signal]);
  assert.equal(alreadyAborted.signal.reason, reason);
  alreadyAborted.dispose();
});

test("ten real HTTP requests abort before delayed headers and during body reads", async () => {
  let disconnected = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/body") { res.writeHead(200); res.write('{"pending":'); }
    const timer = setTimeout(() => res.end("null}"), 2000);
    res.on("close", () => { disconnected++; clearTimeout(timer); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const gc = setInterval(() => global.gc?.(), 20);
  try {
    for (const mode of ["headers", "body"]) {
      await Promise.all(Array.from({ length: 10 }, async () => {
        const lease = new AbortController();
        const scope = requestAbortScope([lease.signal, AbortSignal.timeout(300)]);
        const start = Date.now();
        try {
          await assert.rejects(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/${mode}`, {
              method: "POST", body: "synthetic", cache: "no-store", signal: scope.signal,
            });
            await response.json();
          }, error => error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
          assert.ok(Date.now() - start < 1600, "transport deadline must beat delayed response");
        } finally { scope.dispose(); }
        assert.equal(getEventListeners(lease.signal, "abort").length, 0);
      }));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(disconnected, 20, "aborted requests must close on the server too");
  } finally {
    clearInterval(gc);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
