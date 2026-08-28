import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import test from "node:test";

type ReadyRoute = {
  GET: () => Promise<Response>;
};

async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate a readiness probe port");
  }
  return { server, port: address.port };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readyRoute(): Promise<ReadyRoute> {
  const imported = await import("../src/app/api/ready/route");
  return ((imported as { default?: ReadyRoute }).default ?? imported) as ReadyRoute;
}

test("readiness is healthy and honest in primary-only mode", async () => {
  const primary = await listen();
  const previous = { ...process.env };
  try {
    process.env.VOICE_RELAY_PORT = String(primary.port);
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
    const response = await (await readyRoute()).GET();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.voice_mode, "primary_only");
    assert.equal(body.checks.primary_voice_relay, true);
    assert.equal(body.checks.fallback_voice_relay, null);
    assert.equal(body.checks.fallback_voice_relay_configured, false);
  } finally {
    process.env = previous;
    await close(primary.server);
  }
});

test("configured fallback is required to be reachable", async () => {
  const primary = await listen();
  const unavailableFallback = await listen();
  const fallbackPort = unavailableFallback.port;
  await close(unavailableFallback.server);
  const previous = { ...process.env };
  try {
    process.env.VOICE_RELAY_PORT = String(primary.port);
    process.env.OPENAI_VOICE_RELAY_PORT = String(fallbackPort);
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "configured";
    const response = await (await readyRoute()).GET();
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.voice_mode, "primary_with_fallback");
    assert.equal(body.checks.primary_voice_relay, true);
    assert.equal(body.checks.fallback_voice_relay, false);
    assert.equal(body.checks.fallback_voice_relay_configured, true);
  } finally {
    process.env = previous;
    await close(primary.server);
  }
});
