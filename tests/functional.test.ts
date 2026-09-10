import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Route } from "playwright";

import { buildFunctionalComponent } from "./functional-component-browser";

const componentOnly = process.env.AURAL_FUNCTIONAL_COMPONENT_ONLY === "1";
const simulationCount = Number(process.env.AURAL_LOCAL_CONCURRENCY || (process.env.AURAL_LOCAL_TWENTY === "1" ? "20" : "0"));
assert.ok([0, 10, 15, 20].includes(simulationCount), "Supported local simulation sizes are 10, 15 or 20");
let mountComponent: ((context: BrowserContext) => Promise<void>) | undefined;
async function newContext(options: BrowserContextOptions) {
  const selected = simulationBrowsers.length ? simulationBrowsers[simulationBrowserCursor++ % simulationBrowsers.length] : browser;
  const context = await selected.newContext(options);
  if (mountComponent) await mountComponent(context);
  return context;
}

const APP_CWD = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type RelayConnection = {
  url: string;
  path: string;
};

let browser: Browser;
const simulationBrowsers: Browser[] = [];
let simulationBrowserCursor = 0;
let serverProcess: ChildProcess | undefined;
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
  if (componentOnly) console.error("[component DOM]", await page.locator("body").innerText());
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
  if (componentOnly) {
    baseUrl = "https://aural-component.invalid";
    mountComponent = await buildFunctionalComponent(APP_CWD);
  } else {
    const supplied = process.env.AURAL_FUNCTIONAL_BASE_URL;
    if (supplied) {
      const url = new URL(supplied);
      assert.equal(url.protocol, "http:");
      assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
      baseUrl = url.origin;
    } else {
      const port = await getFreePort();
      baseUrl = `http://127.0.0.1:${port}`;
      serverProcess = startAppServer(port);
    }
    await waitForHttp(`${baseUrl}/login`);
    // A clean release build has no Next.js development cache. Compile the
    // functional voice page once during suite setup so per-scenario navigation
    // timeouts continue to measure runtime behavior instead of cold compilation.
    await waitForHttp(
      `${baseUrl}/functional-tests/voice?language=en&scenario=english-failover`,
      120_000,
    );
  }
  const systemChrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || (process.platform === "win32"
      && existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined);
  const launchOptions = {
    headless: true,
    // Component scenarios mount an already-started interview, without the
    // real notice-page click that authorizes audio playback. Allow their
    // synthetic audio contexts to run; onboarding has its own click tests.
    ...((componentOnly || simulationCount) ? { args: ["--autoplay-policy=no-user-gesture-required"] } : {}),
    ...(systemChrome ? { executablePath: systemChrome } : {}),
  };
  browser = await chromium.launch(launchOptions);
  if (simulationCount) {
    simulationBrowsers.push(browser);
    for (let index = 1; index < Math.ceil(simulationCount / 5); index++) simulationBrowsers.push(await chromium.launch(launchOptions));
  }
});

after(async () => {
  await Promise.all(simulationBrowsers.map(instance => instance.close()));
  if (!simulationBrowsers.length) await browser?.close();
  if (serverProcess) await stopProcess(serverProcess);
});

test("login defaults to English and no longer shows a language toggle", { skip: componentOnly ? "Requires packaged Next server; not component evidence" : false }, async () => {
  const context = await newContext({ locale: "en-US" });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/login`);

  await waitForText(page, "Welcome back");
  assert.equal(await page.getByText("English", { exact: true }).count(), 0);
  assert.equal(await page.getByText("中文", { exact: true }).count(), 0);

  await context.close();
});

test("login honors browser locale and persisted locale cache", { skip: componentOnly ? "Requires packaged Next server; not component evidence" : false }, async () => {
  const zhContext = await newContext({ locale: "zh-CN" });
  const zhPage = await zhContext.newPage();
  await zhPage.goto(`${baseUrl}/login`);
  await waitForText(zhPage, "欢迎回来");
  await zhContext.close();

  const cachedContext = await newContext({ locale: "en-US" });
  const cachedPage = await cachedContext.newPage();
  await cachedPage.addInitScript(() => {
    window.localStorage.setItem("aural.app.locale", "zh");
  });
  await cachedPage.goto(`${baseUrl}/login`);
  await waitForText(cachedPage, "欢迎回来");
  await cachedContext.close();
});

test("voice save rejects an interrupted empty request without a server exception", { skip: componentOnly ? "Requires packaged Next server; not component evidence" : false }, async () => {
  const response = await fetch(`${baseUrl}/api/voice/save`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON body" });
});

test("English interviews try the voice relay first and fail over to OpenAI", async () => {
  const context = await newContext({ locale: "en-US" });
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
  const context = await newContext({ locale: "en-US" });
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
  const context = await newContext({ locale: "en-US" });
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
  const context = await newContext({ locale: "en-US" });
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
  const context = await newContext({ locale: "en-US" });
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
  const context = await newContext({ locale: "en-US" });
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
  const context = await newContext({ locale: "zh-CN" });
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
  assert.equal(await page.getByText("正在听取回答，慢慢来", { exact: true }).count(), 0,
    "The candidate status must also wait for ASR input readiness");

  await waitForText(page, "🎤 正在听,请说", 5_000, true);
  await waitForText(page, "正在听取回答，慢慢来", 5_000, true);
  await context.close();
});

test("a silence reminder restores candidate input on the same question after relay readiness", async () => {
  const context = await newContext({ locale: "zh-CN" });
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-entry&silenceReminder=1`);
    await waitForText(page,"面试须知",10_000,true);
    await page.getByText("我已阅读并同意以上面试须知",{exact:true}).click();
    await page.getByRole("button",{name:"开始面试",exact:true}).click();
    await waitForText(page,"正在听取回答，慢慢来",5_000,true);
    await waitForText(page,"你可以继续补充刚才的回答。",5_000,true);
    assert.equal(await page.getByText("正在听取回答，慢慢来",{exact:true}).count(),0);
    await waitForText(page,"正在听取回答，慢慢来",5_000,true);
    const sent = await readRelaySentMessages(page);
    assert.equal(sent.filter(message=>message.type==="next_question").length,0);
  } finally {
    await context.close();
  }
});

test("browser playback receipt waits for real AudioContext playback before acknowledging", async () => {
  const context = await newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-entry&playbackReceipt=1`);
  await waitForText(page,"面试须知",10_000,true);
  await page.getByText("我已阅读并同意以上面试须知",{exact:true}).click();
  await page.getByRole("button",{name:"开始面试",exact:true}).click();
  await waitForCondition(async()=>await page.evaluate(()=>!!sessionStorage.getItem("__functionalPlaybackAckAt")),10_000);
  const delayMs=await page.evaluate(()=>Number(sessionStorage.getItem("__functionalPlaybackAckAt"))-Number(sessionStorage.getItem("__functionalPlaybackSentAt")));
  assert.ok(delayMs>=1_300,`Acknowledged before 1.5 seconds of audio played: ${delayMs} ms`);
  const sent=await readRelaySentMessages(page);
  const init=sent.find(message=>message.type==="init");
  assert.equal((init?.context as Record<string,unknown>)?.clientPlaybackReceipt,true);
  assert.equal(sent.filter(message=>message.type==="playback_complete").length,1);
  await context.close();
});

test("recruitment notice has one start action then auto-connects camera and microphone", async () => {
  const context = await newContext({ locale: "zh-CN" });
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

test("recruitment entry survives a browser that denies access to localStorage itself", async () => {
  const context = await newContext({ locale: "zh-CN" });
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage access denied", "SecurityError"); },
    });
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-entry`);
  await waitForText(page, "面试须知", 10_000, true);
  assert.equal(await page.getByRole("button", { name: "开始面试", exact: true }).count(), 1);
  await page.getByText("我已阅读并同意以上面试须知", { exact: true }).click();
  await page.getByRole("button", { name: "开始面试", exact: true }).click();
  await waitForCondition(async () => {
    const requests = await readMediaRequests(page);
    return requests.some((request) => !!request.audio) && requests.some((request) => !!request.video);
  }, 15_000, "Storage denial must not block camera or microphone startup");
  await waitForText(page, "第 1 / 8 题", 10_000);
  await context.close();
});

test("recruitment auto-start resumes after online recovery beyond three failed attempts", async () => {
  const context = await newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/functional-tests/voice?language=zh-CN&scenario=recruitment-entry`);
  await waitForText(page, "面试须知", 10_000, true);
  await page.evaluate(() => {
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const state = { blocked: true, attempts: 0 };
    (window as unknown as { recoveryTest: typeof state }).recoveryTest = state;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.attempts++;
      if (state.blocked) throw new DOMException("Temporary device unavailable", "NotReadableError");
      return getMedia(constraints);
    };
  });
  await page.getByText("我已阅读并同意以上面试须知", { exact: true }).click();
  await page.getByRole("button", { name: "开始面试", exact: true }).click();
  await waitForCondition(async () => page.evaluate(() =>
    (window as unknown as { recoveryTest: { attempts: number } }).recoveryTest.attempts >= 3), 10_000);
  await page.evaluate(() => {
    (window as unknown as { recoveryTest: { blocked: boolean } }).recoveryTest.blocked = false;
    window.dispatchEvent(new Event("online"));
  });
  await waitForCondition(async () => {
    const requests = await readMediaRequests(page);
    return requests.some((request) => !!request.audio) && requests.some((request) => !!request.video);
  }, 10_000, "External recovery must resume entry without another start button");
  assert.equal(await page.getByRole("button", { name: "开始面试", exact: true }).count(), 0);
  await context.close();
});

test("recruitment auto-start retries a transient media failure without a second start action", async () => {
  const context = await newContext({ locale: "zh-CN" });
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
  const context = await newContext({ locale: "zh-CN" });
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
  const context = await newContext({ locale: "en-US" });
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

async function runEightQuestionScenario(scenario: string, ready?: () => Promise<void>, progress?: (stage: string, question: number) => void) {
  const context = await newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text().slice(0, 300)); });
  const saveBodies: unknown[] = [];
  let failedCompletion = false;
  let failedProgress = false;
  let recordingWrites = 0;
  await page.route("**/api/session/upload", async (route: Route) => {
    await route.fulfill({ status:200, contentType:"application/json", body:JSON.stringify({url:`${baseUrl}/functional-recording.webm`}) });
  });

  await page.route("**/api/trpc/session.saveRecording", async (route: Route) => {
    recordingWrites++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { data: { json: { success: true } } } }),
    });
  });
  await page.route("**/api/voice/save", async (route: Route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    saveBodies.push(body);
    if (scenario.endsWith("progress-retry") && !body.complete && body.currentQuestionIndex === 1
      && body.messages?.some((m: {role:string}) => m.role === "user") && !failedProgress) {
      failedProgress = true;
      await delay(600);
      assert.match((await page.locator("body").innerText()), /第 2 \/ 8 题/);
      await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"local save failure"})});
      return;
    }
    if (scenario.endsWith("save-retry") && body.validateOnly && !failedCompletion) {
      failedCompletion = true;
      await route.fulfill({ status:409, contentType:"application/json", body:JSON.stringify({error:"本地故障注入：回答保存尚未同步"}) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto(
    `${baseUrl}/functional-tests/voice?language=zh-CN&scenario=${scenario}`,
  );
  await waitForCondition(
    async () => (await page.getByTestId("harness-ready").textContent()) === "true",
    5_000,
  );

  if (ready) {
    await waitForText(page, "第 1 / 8 题", 10_000);
    await waitForText(page, "正在听取回答，慢慢来", 10_000, true);
    await ready();
  }

  for (let question = 1; question <= 8; question += 1) {
    progress?.("read_question", question);
    await waitForText(page, `第 ${question} / 8 题`, 10_000);
    // A question_change arrives just before the relay's input_ready handshake.
    // Wait for the real candidate-input state so the harness cannot submit into
    // that transition window and silently lose an answer.
    await waitForText(page, "正在听取回答，慢慢来", 10_000, true);
    assert.equal(await page.getByTestId("parent-complete").textContent(), "false");

    progress?.("open_input", question);
    await page.getByRole("button", { name: "打开文字输入", exact: true }).click();
    const input = page.getByRole("textbox");
    await input.fill(
      `第${question}题回答：我负责资料核对和入职引导，我不会报未经核验的数据。这是本人的职责、执行步骤、结果数据和验证方法。`,
    );
    await input.press("Enter");
    progress?.("input_submitted", question);
    await page.getByRole("button", { name: "关闭文字输入", exact: true }).click();

    if (question === 2 && scenario.endsWith("premature")) {
      await waitForCondition(async () => (await readRelayConnections(page)).length >= 2, 15_000,
        "Premature completion must reconnect the terminal relay without candidate interaction");
      assert.equal(await page.getByTestId("parent-complete").textContent(), "false");
      assert.equal(recordingWrites, 0, "Camera recording must remain active");
      assert.equal(saveBodies.some((body) => (body as { complete?:boolean }).complete), false);
      const initMessages=(await readRelaySentMessages(page)).filter((m)=>m.type === "init");
      assert.equal((initMessages.at(-1)?.context as { startQuestionIndex:number }).startQuestionIndex, 1);
    }

    if (question < 8) {
      const nextButton = page.locator(
        '[data-tour="voice-status"]:has-text("本题答完了就点这里") button:has-text("下一题")',
      );
      await waitForCondition(
        async () => await nextButton.isVisible().catch(() => false),
        10_000,
        `Expected next-question control after answer ${question}`,
      );
      progress?.("advance", question);
      await nextButton.click();
      if (question === 2 && scenario.endsWith("progress-retry")) {
        await waitForText(page, "刚才的回答暂未保存成功", 8_000);
        assert.equal(failedProgress, true);
        await waitForText(page, "第 2 / 8 题", 3_000);
        await waitForText(page, "正在听取回答，慢慢来", 3_000, true);
        assert.equal(recordingWrites, 0);
        await nextButton.click();
      }
    }
  }

  progress?.("finish", 8);
  if (scenario.endsWith("save-retry")) {
    await waitForCondition(async () => failedCompletion && (await readRelayConnections(page)).length >= 2, 15_000);
    assert.equal(await page.getByTestId("parent-complete").textContent(), "false");
    assert.equal(recordingWrites, 0, "Failed completion must not stop or upload the recording");
    assert.equal(await page.locator("video").evaluateAll((videos) => videos.some((video) => {
      const stream=(video as HTMLVideoElement).srcObject as MediaStream | null;
      return stream?.getVideoTracks().some((track)=>track.readyState === "live");
    })), true);
    await page.locator('[data-tour="voice-progress"] button').nth(2).click();
    await page.getByRole("button", { name:"结束面试", exact:true }).click();
  }

  await waitForCondition(
    async () => (await page.getByTestId("parent-complete").textContent()) === "true",
    15_000,
    "Expected completion only after the eighth answer was saved",
  ).catch(async (error) => {
    const sent = await readRelaySentMessages(page);
    console.error("[completion-diagnostic]", JSON.stringify({
      scenario,
      browserErrors,
      recordingWrites,
      saves: saveBodies.map((body) => {
        const b = body as {complete?:boolean;validateOnly?:boolean;currentQuestionIndex?:number;messages?:Array<{role:string}>};
        return {complete:b.complete,validateOnly:b.validateOnly,index:b.currentQuestionIndex,users:b.messages?.filter(m=>m.role==="user").length};
      }),
      sentTypes: sent.map(m=>m.type),
    }));
    throw error;
  });
  const sent = await readRelaySentMessages(page);
  assert.equal(sent.filter((message) => message.type === "text_input").length, 8);
  assert.equal(sent.filter((message) => message.type === "next_question").length, scenario.endsWith("progress-retry") ? 8 : 7);
  assert.equal(sent.filter((message) => message.type === "answer_commit_ack" && message.ok === true).length, 7);
  if (scenario.endsWith("progress-retry")) {
    const q2Writes = saveBodies.filter((b) => (b as {currentQuestionIndex:number}).currentQuestionIndex === 1) as Array<{messages:Array<{content:string}>}>;
    assert.ok(q2Writes.filter((b)=>b.messages.some((m)=>m.content.includes("我不会报未经核验的数据"))).length >= 2, "Failed answer must be retained for the retry");
  }
  const completionWrites = saveBodies.filter(
    (body) => (body as { complete?: boolean }).complete === true,
  );
  assert.equal(completionWrites.length, 1);
  assert.equal(recordingWrites, 1);

  progress?.("passed", 8);
  await context.close();
}

for (const scenario of ["recruitment-eight-question", "recruitment-eight-question-premature", "recruitment-eight-question-save-retry", "recruitment-eight-question-progress-retry"]) {
test(`recruitment completes only after eight distinct scored answers: ${scenario}`, async () => {
  await runEightQuestionScenario(scenario);
});
}

// Explicit local simulation gate. Mocks verify UI/save behavior, not live GLM or database capacity.
test(`${simulationCount} concurrent local interview simulations finish all eight answers`, { skip: !simulationCount, timeout: 240_000 }, async () => {
  let readyCount = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const watchdog = setTimeout(() => release(), 60_000);
  const ready = async () => {
    readyCount++;
    if (readyCount === simulationCount) release();
    await barrier;
    assert.equal(readyCount, simulationCount, "All browser sessions must overlap before answering");
  };
  const scenarios = ["recruitment-eight-question", "recruitment-eight-question-premature", "recruitment-eight-question-save-retry", "recruitment-eight-question-progress-retry"];
  try {
    const stages = new Map<number, {stage: string; question: number}>();
    const results = await Promise.allSettled(Array.from({length: simulationCount}, (_, i) => runEightQuestionScenario(scenarios[i % scenarios.length], ready, (stage, question) => {
      stages.set(i + 1, {stage, question});
      console.log("LOCAL_PROGRESS", JSON.stringify({session: i + 1, stage, question, at: Date.now()}));
    })));
    const failures = results.flatMap((result, index) => result.status === "rejected" ? [{session: index + 1, ...stages.get(index + 1), error: String(result.reason)}] : []);
    console.log("LOCAL_CONCURRENCY_RESULT", JSON.stringify({requested: simulationCount, browsers: simulationBrowsers.length, ready: readyCount, passed: results.length - failures.length, failed: failures.length, failures, providerCalls: 0, persistence: "mocked"}));
    assert.equal(failures.length, 0, JSON.stringify(failures));
  } finally { clearTimeout(watchdog); }
});

test("voice completion shows the farewell, waits for final save, and only then notifies the parent", async () => {
  const context = await newContext({ locale: "en-US" });
  const page = await context.newPage();
  let resolveSave: (() => void) | null = null;
  const saveBodies: unknown[] = [];

  await page.route("**/api/voice/save", async (route: Route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    // Allow ordinary answer flushes; delay only the terminal persistence ack.
    if (!body.complete) {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    saveBodies.push(body);
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
