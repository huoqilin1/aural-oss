import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page, type Route } from "playwright";

const APP_CWD = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type RelayConnection = {
  url: string;
  path: string;
};

let browser: Browser;
let serverProcess: ChildProcess;
let baseUrl = "";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      // server still starting
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startAppServer(port: number): ChildProcess {
  const nextCli = resolve(APP_CWD, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "dev", "--port", String(port)], {
    cwd: APP_CWD,
    env: {
      ...process.env,
      NODE_ENV: "development",
      ENABLE_FUNCTIONAL_TEST_PAGES: "1",
      SUPABASE_URL: process.env.SUPABASE_URL || "https://functional-test.supabase.co",
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "functional-test-key",
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.SUPABASE_SERVICE_ROLE_KEY || "functional-test-service-key",
      NEXT_PUBLIC_SUPABASE_URL:
        process.env.NEXT_PUBLIC_SUPABASE_URL || "https://functional-test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "functional-test-key",
      NEXT_PUBLIC_VOICE_RELAY_URL: `ws://127.0.0.1:${port}/ws/voice`,
      NEXT_PUBLIC_OPENAI_VOICE_RELAY_URL: `ws://127.0.0.1:${port}/ws/openai-voice`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[functional-next] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[functional-next] ${chunk}`);
  });

  return child;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(10_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function readRelayConnections(page: Page): Promise<RelayConnection[]> {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem("__functionalRelayConnections");
    return raw ? (JSON.parse(raw) as RelayConnection[]) : [];
  });
}

async function readRelaySentMessages(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem("__functionalRelaySentMessages");
    return raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
  });
}

async function readMediaRequests(page: Page): Promise<MediaStreamConstraints[]> {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem("__functionalMediaRequests");
    return raw ? (JSON.parse(raw) as MediaStreamConstraints[]) : [];
  });
}

async function waitForText(
  page: Page,
  text: string,
  timeoutMs = 10_000,
  exact = false,
): Promise<void> {
  const locator = page.getByText(text, { exact });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (
      await locator
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
  message = "Timed out waiting for condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function startVoiceInterview(page: Page): Promise<void> {
  await page.getByRole("button", {
    name: /开始语音测试|允许麦克风并开始面试/,
  }).click();
}

before(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = startAppServer(port);
  await waitForHttp(`${baseUrl}/login`);
  const systemChrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || (process.platform === "win32"
      && existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(systemChrome ? { executablePath: systemChrome } : {}),
  });
});

after(async () => {
  await browser?.close();
  await stopProcess(serverProcess);
});

test("login defaults to English and no longer shows a language toggle", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/login`);

  await waitForText(page, "Welcome back");
  assert.equal(await page.getByText("English", { exact: true }).count(), 0);
  assert.equal(await page.getByText("中文", { exact: true }).count(), 0);

  await context.close();
});

test("login honors browser locale and persisted locale cache", async () => {
  const zhContext = await browser.newContext({ locale: "zh-CN" });
  const zhPage = await zhContext.newPage();
  await zhPage.goto(`${baseUrl}/login`);
  await waitForText(zhPage, "欢迎回来");
  await zhContext.close();

  const cachedContext = await browser.newContext({ locale: "en-US" });
  const cachedPage = await cachedContext.newPage();
  await cachedPage.addInitScript(() => {
    window.localStorage.setItem("aural.app.locale", "zh");
  });
  await cachedPage.goto(`${baseUrl}/login`);
  await waitForText(cachedPage, "欢迎回来");
  await cachedContext.close();
});

test("voice save rejects an interrupted empty request without a server exception", async () => {
  const response = await fetch(`${baseUrl}/api/voice/save`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON body" });
});

test("English interviews try the voice relay first and fail over to OpenAI", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto(
    `${baseUrl}/functional-tests/voice?language=en&scenario=english-failover`,
  );
  await waitForCondition(
    async () =>
      (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
    "Expected functional voice harness mocks to be ready",
  );
  await startVoiceInterview(page);

  await delay(3_500);

  const connections = await readRelayConnections(page);
  assert.deepEqual(
    connections.map((entry) => entry.path),
    ["/ws/voice", "/ws/openai-voice"],
  );

  await context.close();
});

test("Chinese interviews also try the voice relay first and fail over to OpenAI", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto(
    `${baseUrl}/functional-tests/voice?language=zh-CN&scenario=chinese-failover`,
  );
  await waitForCondition(
    async () =>
      (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
    "Expected functional voice harness mocks to be ready",
  );
  await startVoiceInterview(page);

  await delay(3_500);

  const connections = await readRelayConnections(page);
  assert.deepEqual(
    connections.map((entry) => entry.path),
    ["/ws/voice", "/ws/openai-voice"],
  );

  await context.close();
});

test("voice interview shows Thinking after user speech finalizes", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=en&scenario=thinking-after-asr`,
  );
  await waitForCondition(
    async () =>
      (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
    "Expected functional voice harness mocks to be ready",
  );
  await startVoiceInterview(page);

  await waitForText(page, "Thinking...", 8_000);
  const bodyText = (await page.locator("body").textContent()) ?? "";
  assert.equal(bodyText.includes("I led a reporting dashboard project"), true);
  assert.equal(
    bodyText.includes("Speak naturally — AI will respond automatically"),
    false,
  );

  await context.close();
});

test("voice interview keeps Thinking visible until the agent response returns", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=en&scenario=thinking-until-response`,
  );
  await waitForCondition(
    async () =>
      (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
    "Expected functional voice harness mocks to be ready",
  );
  await startVoiceInterview(page);

  await waitForText(page, "Thinking...", 8_000);
  await delay(500);
  assert.equal(
    await page.getByText("Thinking...", { exact: true }).first().isVisible(),
    true,
  );
  let bodyText = (await page.locator("body").textContent()) ?? "";
  assert.equal(
    bodyText.includes("Speak naturally — AI will respond automatically"),
    false,
  );

  await waitForText(page, "Thanks for explaining that project.", 8_000);
  await waitForCondition(
    async () =>
      !(await page
        .getByText("Thinking...", { exact: true })
        .first()
        .isVisible()
        .catch(() => false)),
    5_000,
    "Expected Thinking to clear once the agent response is visible",
  );
  bodyText = (await page.locator("body").textContent()) ?? "";
  assert.equal(bodyText.includes("Thanks for explaining that project."), true);

  await context.close();
});

test("next-question control sends one request and waits for relay acknowledgement", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=en&scenario=advance-idempotency`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );
  assert.equal(
    await page.getByRole("button", {
      name: /开启摄像头|摄像头测试|开始语音测试|允许麦克风并开始面试/,
    }).count(),
    0,
  );
  await waitForText(page, "Thanks, that evidence is clear.", 8_000);

  const nextButton = page.getByRole("button", { name: "下一题" }).first();
  await waitForCondition(async () => await nextButton.isEnabled(), 5_000);
  await nextButton.dblclick();

  await waitForText(page, "Explain a difficult decision you made in that project.", 5_000);
  const sent = await readRelaySentMessages(page);
  assert.equal(sent.filter((message) => message.type === "next_question").length, 1);
  assert.equal(
    typeof sent.find((message) => message.type === "next_question")?.requestId,
    "string",
  );

  await context.close();
});

test("latest follow-up must be answered before next-question control unlocks", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=en&scenario=advance-followup-guard`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );
  assert.equal(
    await page.getByRole("button", {
      name: /开启摄像头|摄像头测试|开始语音测试|允许麦克风并开始面试/,
    }).count(),
    0,
  );
  await waitForCondition(
    async () => (await readRelayConnections(page)).some((entry) => entry.path === "/ws/voice"),
    15_000,
    "Expected the primary relay connection before checking follow-up behavior",
  );
  await waitForText(page, "Could you explain the exact metric and verification method?", 10_000);

  const nextButtons = page.getByRole("button", { name: "下一题" });
  assert.equal(await nextButtons.first().isEnabled().catch(() => false), false);
  const sent = await readRelaySentMessages(page);
  assert.equal(sent.filter((message) => message.type === "next_question").length, 0);

  await context.close();
});

test("recruitment entry auto-connects media and rejects completion before eight answers", async () => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  const saveBodies: unknown[] = [];

  await page.route("**/api/trpc/session.saveRecording", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { data: { json: { success: true } } } }),
    });
  });
  await page.route("**/api/voice/save", async (route: Route) => {
    saveBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "八道计分题尚未完整完成，请继续完成当前面试" }),
    });
  });

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-incomplete`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );
  assert.equal(
    await page.getByRole("button", {
      name: /开启摄像头|摄像头测试|麦克风测试|语音测试|开始语音测试|允许麦克风并开始面试/,
    }).count(),
    0,
  );
  await waitForCondition(async () => {
    const requests = await readMediaRequests(page);
    return requests.some((request) => !!request.audio)
      && requests.some((request) => !!request.video);
  }, 15_000, "Expected recruitment camera and microphone to connect automatically");
  await waitForText(page, "第 1 / 8 题", 10_000);

  await page.locator('[data-tour="voice-progress"] button').nth(2).click();
  await page.getByRole("button", { name: "结束面试", exact: true }).click();
  await waitForText(page, "八道计分题尚未完整完成，请继续完成当前面试", 10_000);

  assert.equal(saveBodies.length, 0);
  assert.equal(await page.getByTestId("parent-complete").textContent(), "false");
  assert.equal(await page.getByText("第 1 / 8 题", { exact: true }).count() > 0, true);

  await context.close();
});

test("recruitment completes only after eight distinct scored answers", async () => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  const saveBodies: unknown[] = [];

  await page.route("**/api/trpc/session.saveRecording", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { data: { json: { success: true } } } }),
    });
  });
  await page.route("**/api/voice/save", async (route: Route) => {
    saveBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-eight-question`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );

  for (let question = 1; question <= 8; question += 1) {
    await waitForText(page, `第 ${question} / 8 题`, 10_000);
    assert.equal(await page.getByTestId("parent-complete").textContent(), "false");

    await page.locator('[data-tour="voice-chat"] button').click();
    const input = page.getByRole("textbox");
    await input.fill(
      `第${question}题回答：这是基于真实经历的具体证据，包含本人职责、执行步骤、结果数据和验证方法。`,
    );
    await input.press("Enter");
    await page.locator('[data-tour="voice-chat"] button').click();

    if (question < 8) {
      const nextButton = page.locator(
        '[data-tour="voice-status"]:has-text("本题答完了就点这里") button:has-text("下一题")',
      );
      await waitForCondition(
        async () => await nextButton.isVisible().catch(() => false),
        10_000,
        `Expected next-question control after answer ${question}`,
      );
      await nextButton.click();
    }
  }

  await waitForCondition(
    async () => (await page.getByTestId("parent-complete").textContent()) === "true",
    15_000,
    "Expected completion only after the eighth answer was saved",
  );
  const sent = await readRelaySentMessages(page);
  assert.equal(sent.filter((message) => message.type === "text_input").length, 8);
  assert.equal(sent.filter((message) => message.type === "next_question").length, 7);
  const completionWrites = saveBodies.filter(
    (body) => (body as { complete?: boolean }).complete === true,
  );
  assert.equal(completionWrites.length, 1);

  await context.close();
});

test("voice completion shows the farewell, waits for final save, and only then notifies the parent", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  let resolveSave: (() => void) | null = null;
  const saveBodies: unknown[] = [];

  await page.route("**/api/voice/save", async (route: Route) => {
    saveBodies.push(JSON.parse(route.request().postData() || "{}"));
    await new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=en&scenario=farewell-complete`,
  );
  await waitForCondition(
    async () =>
      (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
    "Expected functional voice harness mocks to be ready",
  );
  await startVoiceInterview(page);

  await delay(1_500);
  const earlyBodyText = (await page.locator("body").textContent()) ?? "";
  assert.equal(
    earlyBodyText.includes(
      "Understood, we're all set. Thanks for your time today and take care.",
    ),
    true,
  );
  assert.equal(earlyBodyText.includes("Thank you!"), false);
  assert.equal(
    await page.getByTestId("parent-complete").textContent(),
    "false",
  );

  await waitForCondition(
    async () => saveBodies.length === 1,
    6_000,
    "Expected final voice save to be sent once",
  );

  const [savePayload] = saveBodies as Array<Record<string, unknown>>;
  assert.equal(savePayload.complete, true);
  assert.equal(
    await page.getByTestId("parent-complete").textContent(),
    "false",
  );

  const fn = resolveSave as (() => void) | null;
  if (fn) fn();

  await delay(500);
  assert.equal(await page.getByTestId("parent-complete").textContent(), "true");
  await waitForText(page, "面试已顺利完成", 5_000);

  await context.close();
});
