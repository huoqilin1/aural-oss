import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {createHash} from 'node:crypto';
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

async function syntheticMediaUpload(route: Route) {
  const raw=route.request().postDataBuffer();
  assert.ok(raw);
  const form=await new Response(new Uint8Array(raw),{headers:{'Content-Type':route.request().headers()['content-type']}}).formData();
  const blob=form.get('file') as Blob;
  const hash=createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
  const type=String(form.get('type'));
  return {type,hash,url:`${baseUrl}/synthetic-${hash}`,path:`${form.get('sessionId')}/${hash}`,bucket:type==='recording'?'recordings':'screenshots'};
}

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
  const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
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
  // A clean release build has no Next.js development cache. Compile the
  // functional voice page once during suite setup so per-scenario navigation
  // timeouts continue to measure runtime behavior instead of cold compilation.
  await waitForHttp(
    `${baseUrl}/functional-tests/voice?language=en&scenario=english-failover`,
    120_000,
  );
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

test("voice interview does not show Thinking from speech finalization alone", async () => {
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

  // 王总 2026-09-03：asr_ended 只代表"这句已提交"，不再点亮"思考中"——
  // 答题停顿不应让界面闪 Thinking，只有 AI 真正开始生成(response_started)才显示。
  await waitForText(page, "I led a reporting dashboard project", 8_000);
  await delay(800);
  assert.equal(
    await page.getByText("Thinking...", { exact: true }).first().isVisible(),
    false,
    "Expected no Thinking indicator from speech finalization alone",
  );
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
  const nextButton = page.getByRole("button", { name: "下一题" }).first();
  // The acknowledgement copy is incidental setup. The stable contract is that
  // the relay response has finished and the next control is enabled. Clean WSL
  // builds can compile/hydrate more slowly than a warm Windows workspace.
  await waitForCondition(
    async () => await nextButton.isEnabled({ timeout: 250 }).catch(() => false),
    20_000,
    "Expected next-question control after relay acknowledgement",
  );
  await nextButton.dblclick();

  await waitForText(page, "Explain a difficult decision you made in that project.", 10_000);
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
  assert.equal(
    await nextButtons.first().isEnabled({ timeout: 250 }).catch(() => false),
    false,
  );
  const sent = await readRelaySentMessages(page);
  assert.equal(sent.filter((message) => message.type === "next_question").length, 0);

  await context.close();
});

test("candidate input stays unavailable until the relay confirms ASR readiness", async () => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=zh-CN&scenario=advance-input-readiness`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );
  await waitForText(
    page,
    "Explain a difficult decision you made in that project.",
    10_000,
  );
  await page.waitForTimeout(750);

  assert.equal(
    await page.getByText("🎤 正在听,请说", { exact: true }).count(),
    0,
    "Question change, TTS completion, and reconnect alone must not claim ASR readiness",
  );

  await waitForText(page, "🎤 正在听,请说", 5_000, true);
  await context.close();
});

test("recruitment notice has one start action then auto-connects camera and microphone", async () => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-entry`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );

  await waitForText(page, "面试须知", 10_000, true);
  assert.equal(await page.getByRole("button", { name: "开始面试", exact: true }).count(), 1);
  assert.equal(
    await page.getByRole("button", {
      name: /开启摄像头|摄像头测试|麦克风测试|语音测试|开始语音测试|允许麦克风并开始面试/,
    }).count(),
    0,
  );
  assert.deepEqual(await readMediaRequests(page), []);

  await page.getByText("我已阅读并同意以上面试须知", { exact: true }).click();
  await page.getByRole("button", { name: "开始面试", exact: true }).click();

  await waitForCondition(
    async () => await page.getByRole("button", { name: "开始面试", exact: true }).count() === 0,
    5_000,
    "Expected the single start action to disappear after entry",
  );
  await waitForCondition(async () => {
    const requests = await readMediaRequests(page);
    return requests.some((request) => !!request.audio)
      && requests.some((request) => !!request.video);
  }, 15_000, "Expected recruitment camera and microphone to connect automatically");
  await waitForText(page, "第 1 / 8 题", 10_000);

  await page.reload();
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );
  assert.equal(
    await page.getByRole("button", { name: "开始面试", exact: true }).count(),
    0,
    "Expected a refreshed recruitment interview to resume without a second start action",
  );
  await waitForCondition(async () => {
    const requests = await readMediaRequests(page);
    return requests.some((request) => !!request.audio)
      && requests.some((request) => !!request.video);
  }, 15_000, "Expected refreshed recruitment interview media to reconnect automatically");
  await waitForText(page, "第 1 / 8 题", 10_000);

  await context.close();
});

test("recruitment auto-start retries a transient media failure without a second start action", async () => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-auto-retry`,
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
    const audioRequests = requests.filter((request) => !!request.audio);
    return audioRequests.length >= 2 && requests.some((request) => !!request.video);
  }, 15_000, "Expected recruitment auto-start to recover from a transient media failure");
  await waitForText(page, "第 1 / 8 题", 10_000);

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

test("a late ASR final from the previous question is not saved twice", async () => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const saveBodies: Array<{ messages?: Array<{ content?: string }> }> = [];

  await page.route("**/api/voice/save", async (route: Route) => {
    saveBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=en&scenario=advance-late-asr`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );
  await waitForText(
    page,
    "Explain a difficult decision you made in that project.",
    10_000,
  );
  await page.waitForTimeout(750);

  const savedMessages = saveBodies.flatMap((body) => body.messages || []);
  assert.equal(
    savedMessages.filter((message) => message.content === "I owned the first project answer.").length,
    1,
  );

  await context.close();
});

for (const loseFirstResponse of [false, true]) {
  test(`same response to different questions is retained; lost first response=${loseFirstResponse}`, async () => {
    const context = await browser.newContext({locale:'zh-CN'});
    const page = await context.newPage();
    const batches: Array<{messages:Array<{content:string; questionId:string; messageId:string}>}> = [];
    await page.route('**/api/voice/save', async route => {
      batches.push(JSON.parse(route.request().postData() || '{}'));
      if (loseFirstResponse && batches.length === 1) await route.abort('connectionreset');
      else await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
    });
    await page.route('**/api/session/upload', async route => {
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(await syntheticMediaUpload(route))});
    });
    await page.goto(`${baseUrl}/functional-tests/voice?language=zh-CN&scenario=advance-repeated-answer`);
    await waitForCondition(async()=>batches.length >= 2,10000);
    const messages=batches.flatMap(batch=>batch.messages).filter(message=>message.content==='我没有做过。');
    assert.deepEqual(Array.from(new Set(messages.map(message=>message.questionId))).sort(),['functional-q1','functional-q2']);
    if (loseFirstResponse) {
      const first=batches[0].messages[0];
      assert.ok(batches[1].messages.some(message=>message.messageId===first.messageId && message.content===first.content));
    }
    await context.close();
  });
}

test('page refresh retains the original unacknowledged voice batch for retry', async () => {
  const context=await browser.newContext({locale:'zh-CN'});
  const page=await context.newPage();
  const batches:Array<{messages:Array<{messageId:string;content:string}>}>=[];
  let refreshed=false;
  await page.route('**/api/voice/save',async route=>{
    batches.push(JSON.parse(route.request().postData()||'{}'));
    if (!refreshed) await route.abort('connectionreset');
    else await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  await page.route('**/api/session/upload',async route=>{
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(await syntheticMediaUpload(route))});
  });
  await page.goto(`${baseUrl}/functional-tests/voice?language=zh-CN&scenario=advance-repeated-answer`);
  await waitForCondition(async()=>batches.length>=2,10000);
  const originalId=batches[0].messages[0].messageId;
  const before=batches.length;
  const stored=await page.evaluate(()=>window.sessionStorage.getItem('aural:pending-voice:v1:functional-session'));
  assert.ok(stored?.includes(originalId));
  refreshed=true;
  await page.reload();
  await waitForCondition(async()=>batches.slice(before).some(batch=>batch.messages.some(message=>message.messageId===originalId)),10000);
  await context.close();
});

test("answer revision reaches browser save once on the original question", async () => {
  const context = await browser.newContext({locale: 'zh-CN'});
  const page = await context.newPage();
  const saved: Array<{messages?: Array<{content?: string; questionId?: string; timestamp?: string; messageId?: string}>}> = [];
  await page.route('**/api/voice/save', async route => {
    saved.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({status: 200, contentType: 'application/json', body: '{"ok":true}'});
  });
  await page.goto(`${baseUrl}/functional-tests/voice?language=zh-CN&scenario=advance-answer-revision`);
  await waitForCondition(async () => saved.length > 0, 10000);
  const messages = saved.flatMap(batch => batch.messages || []);
  const revisions = messages.filter(message => message.content?.includes('语音识别修订'));
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].questionId, 'functional-q1');
  assert.ok(revisions[0].content?.includes('5%，不是15%'));
  assert.ok(Number.isFinite(Date.parse(revisions[0].timestamp!)));
  assert.equal(revisions[0].messageId,'00000000-0000-4000-8000-000000000001');
  assert.equal(revisions[0].timestamp,'2026-09-05T01:02:00Z');
  assert.equal(messages.some(message => message.content?.includes('不应保存')), false);
  await context.close();
});

for (const mediaFailure of ['none','metadata','recording','screenshot']) {
test(`recruitment completes only after eight distinct scored answers (media: ${mediaFailure})`, async () => {
  const failRecordingMetadataOnce=mediaFailure==='metadata';
  let allowUpload=mediaFailure==='none' || failRecordingMetadataOnce;
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  const saveBodies: unknown[] = [];
  const recordingBodies: Array<Record<string, unknown>> = [];
  const uploads: Array<{type:string;hash:string}> = [];

  await page.route("**/api/session/upload", async route => {
    const data=await syntheticMediaUpload(route);
    uploads.push(data);
    if (!allowUpload && data.type===mediaFailure) {
      await route.fulfill({status:503,body:'synthetic upload failure'});return;
    }
    await route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify(data)});
  });

  await page.route("**/api/trpc/session.saveRecording", async (route: Route) => {
    const payload = JSON.parse(route.request().postData() || '{}').json;
    recordingBodies.push(payload);
    if (failRecordingMetadataOnce && recordingBodies.length === 1) {
      await route.fulfill({status:503,body:'temporary storage failure'});
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { data: { json: { success: true, sessionId:payload.sessionId } } } }),
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
    // A question_change arrives just before the relay's input_ready handshake.
    // Wait for the real candidate-input state so the harness cannot submit into
    // that transition window and silently lose an answer.
    await waitForText(page, "正在听取回答，慢慢来", 10_000, true);
    assert.equal(await page.getByTestId("parent-complete").textContent(), "false");

    await page.getByRole("button", { name: "打开文字输入", exact: true }).click();
    const input = page.getByRole("textbox");
    await input.fill(
      `第${question}题回答：这是基于真实经历的具体证据，包含本人职责、执行步骤、结果数据和验证方法。`,
    );
    await input.press("Enter");
    await page.getByRole("button", { name: "关闭文字输入", exact: true }).click();

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

  if (mediaFailure!=='none') {
    await waitForText(page,failRecordingMetadataOnce ? '录音资料保存失败' : '录音或截图尚未上传完成',15000);
    assert.equal(await page.getByTestId('parent-complete').textContent(),'false');
    assert.equal(saveBodies.some(body => (body as {complete?:boolean}).complete),false);
    if(!failRecordingMetadataOnce) assert.equal(recordingBodies.length,0);
    allowUpload=true;
    await page.locator('[data-tour="voice-progress"] button').nth(2).click();
    await page.getByRole('button',{name:'结束面试',exact:true}).click();
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
  assert.equal(recordingBodies.length,failRecordingMetadataOnce ? 2 : 1);
  assert.equal(typeof recordingBodies[0].audioRecordingUrl,'string');
  if (failRecordingMetadataOnce) assert.deepEqual(recordingBodies[1],recordingBodies[0]);
  if (mediaFailure==='recording' || mediaFailure==='screenshot') {
    const retries=uploads.filter(upload=>upload.type===mediaFailure);
    assert.ok(retries.length>=2);
    assert.equal(new Set(retries.map(upload=>upload.hash)).size,1);
    assert.ok((recordingBodies[0].screenshots as unknown[]).length>0);
  }

  await context.close();
});
}

test("switching sessions isolates old transcript state and a late completion response", async () => {
  const context=await browser.newContext({locale:'en-US'});
  const page=await context.newPage();
  let release: (()=>void) | undefined;
  let started=false;
  await page.route('**/api/voice/save',async route => {
    const body=JSON.parse(route.request().postData() || '{}');
    if (body.complete && body.sessionId === 'functional-session') {
      started=true;
      await new Promise<void>(resolve => {release=resolve;});
    }
    await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  try {
    await page.goto(`${baseUrl}/functional-tests/voice?language=en&scenario=farewell-complete`);
    await waitForCondition(async () => (await page.getByTestId('harness-ready').textContent()) === 'true',5000);
    await startVoiceInterview(page);
    await waitForCondition(async () => started,10000);
    await page.getByTestId('switch-synthetic-session').click();
    await delay(200);
    assert.equal((await page.locator('body').textContent())?.includes("Understood, we're all set."),false);
    release!();
    await delay(500);
    assert.equal(await page.getByTestId('parent-complete').textContent(),'false');
  } finally {
    release?.();
    await delay(100);
    await context.close();
  }
});

test("completion retry after a UI timeout does not send a second completion request", async () => {
  const context = await browser.newContext({locale:'en-US'});
  const page = await context.newPage();
  let release: (()=>void) | undefined;
  let requests = 0;
  await page.route('**/api/voice/save', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.complete) {
      requests++;
      await new Promise<void>(resolve => {release=resolve;});
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
  });
  try {
    await page.goto(`${baseUrl}/functional-tests/voice?language=en&scenario=farewell-complete`);
    await waitForCondition(async () => (await page.getByTestId('harness-ready').textContent()) === 'true',5000);
    await startVoiceInterview(page);
    await waitForCondition(async () => requests===1,10000);
    await waitForText(page,'voice disconnect timed out',12000);
    assert.equal(await page.getByTestId('parent-complete').textContent(),'false');
    await page.locator('[data-tour="voice-progress"] button').nth(2).click();
    await page.getByRole('button',{name:'结束面试',exact:true}).click();
    await delay(200);
    assert.equal(requests,1);
    release!();
    await waitForCondition(async () => (await page.getByTestId('parent-complete').textContent()) === 'true',5000);
    assert.equal(requests,1);
  } finally {
    release?.();
    await context.close();
  }
});

test('invitation reaches voice init and authenticated final save without another start step',async()=>{
  const context=await browser.newContext({locale:'en-US'});
  const page=await context.newPage();
  let saved=false;
  await page.route('**/api/voice/save',async route=>{
    const token=route.request().headers()['x-interview-invite'];
    const body=JSON.parse(route.request().postData() || '{}');
    assert.equal(token,'synthetic-invite');
    assert.equal(body.sessionId,'functional-session');
    saved=body.complete===true || saved;
    await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  try {
    await page.goto(`${baseUrl}/functional-tests/voice?language=en&scenario=farewell-complete`);
    await waitForCondition(async()=>(await page.getByTestId('harness-ready').textContent())==='true',5000);
    await page.evaluate(()=>window.history.replaceState(null,'','/i/invite/synthetic-invite/session?language=en&scenario=farewell-complete'));
    await startVoiceInterview(page);
    await waitForCondition(async()=>(await page.getByTestId('parent-complete').textContent())==='true',15000);
    assert.equal(saved,true);
    const inits=(await readRelaySentMessages(page)).filter(message=>message.type==='init');
    assert.ok(inits.length>0);
    assert.ok(inits.every(message=>(message.context as {inviteToken?:string})?.inviteToken==='synthetic-invite'));
  } finally {await context.close();}
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
