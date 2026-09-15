import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, webkit, devices, type Browser, type BrowserContext, type Page } from "playwright";
import { buildFunctionalComponent } from "./functional-component-browser";

const root = process.env.AURAL_ENTRY_SOURCE_ROOT || resolve(__dirname, "..");
const engine = process.env.ENTRY_BROWSER === "webkit" ? webkit : chromium;
const output = process.env.ENTRY_EVIDENCE_DIR
  ? resolve(process.env.ENTRY_EVIDENCE_DIR)
  : resolve(root, `output/entry-browser-${engine.name()}`);
let browser: Browser;
let mount: (ctx: BrowserContext) => Promise<void>;
before(async () => {
  mkdirSync(output, { recursive: true });
  mount = await buildFunctionalComponent(root);
  browser = await engine.launch({ headless: true,
    ...(engine === webkit && process.env.ENTRY_WEBKIT_EXECUTABLE_PATH
      ? { executablePath: process.env.ENTRY_WEBKIT_EXECUTABLE_PATH } : {}),
  });
  console.log(`Entry browser: ${engine.name()} ${browser.version()}`);
  console.log(JSON.stringify({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    userAgent:process.env.ENTRY_USER_AGENT || 'engine default',realIPhone:false,fullNextPage:false}));
});
after(async () => { await browser?.close(); });

async function open(mode: string) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: process.env.ENTRY_USER_AGENT || (engine === webkit ? devices["iPhone 13"].userAgent : undefined) });
  await mount(ctx);
  // tsx preserves function names via this helper when serializing evaluate callbacks.
  await ctx.addInitScript("window.__name = (fn) => fn;");
  const page = await ctx.newPage();
  page.on("console", message => { if (message.type() === "error") console.error("[entry-console]", message.text().slice(0, 500)); });
  // tsx name helpers are lexical in WebKit's evaluation realm; remove only the
  // non-semantic name wrapper from test callbacks before browser serialization.
  const evaluate = page.evaluate.bind(page);
  page.evaluate = ((fn: unknown, arg: unknown) => evaluate(typeof fn === "function"
    ? `(${fn.toString().replace(/\b__name\(/g, "((fn) => fn)(")})(${JSON.stringify(arg) ?? "undefined"})`
    : String(fn))) as typeof page.evaluate;
  await page.goto("https://aural-component.invalid/functional-tests/voice?language=zh-CN&scenario=recruitment-entry");
  await page.getByRole("button", { name: "开始面试", exact: true }).waitFor();
  await page.evaluate(mode => {
    const win = window as typeof window & { __entryProbe: {
      mode: string; calls: number; tracks: MediaStreamTrack[]; clones: MediaStreamTrack[]; clickCalls: number; failures: string[];
      permission: PermissionState; grant: () => void; finish: () => void;
    } };
    const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const statuses = new Map<string, EventTarget>();
    const probe = win.__entryProbe = { mode, calls: 0, tracks: [] as MediaStreamTrack[], clones: [] as MediaStreamTrack[], clickCalls: 0, failures: [] as string[],
      permission: "prompt" as PermissionState, grant: () => {}, finish: () => {} };
    const query = async (descriptor: PermissionDescriptor) => {
      const status = new EventTarget();
      Object.defineProperty(status, "state", { get: () => probe.permission });
      statuses.set(descriptor.name, status);
      return status as PermissionStatus;
    };
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query } });
    const clone = MediaStreamTrack.prototype.clone;
    MediaStreamTrack.prototype.clone = function() { const track = clone.call(this); probe.clones.push(track); return track; };
    probe.grant = () => { probe.permission = "granted"; statuses.forEach(status => status.dispatchEvent(new Event("change"))); };
    navigator.mediaDevices.getUserMedia = (constraints) => {
      probe.calls++;
      const acquire = () => media(constraints).then(stream => { probe.tracks.push(...stream.getTracks()); return stream; })
        .catch(error => { probe.failures.push(error.name + ': ' + error.message); throw error; });
      if (probe.mode === "denied") { probe.permission = "denied"; return Promise.reject(new DOMException("denied", "NotAllowedError")); }
      if (probe.mode === "missing") return Promise.reject(new DOMException("missing", "NotFoundError"));
      if (probe.mode === "pending" || (probe.mode === "stale" && probe.calls === 1)) {
        return new Promise((resolve, reject) => { probe.finish = () => acquire().then(resolve, reject); });
      }
      return acquire();
    };
    // The DOM click bubbles after React's button handler. This proves acquisition is
    // initiated by that same user click, not by a later component effect.
    document.addEventListener("click", event => {
      if ((event.target as HTMLElement).closest("button")?.textContent?.includes("开始面试")) probe.clickCalls = probe.calls;
    });
  }, mode);
  await page.getByText("我已阅读并同意以上面试须知", { exact: true }).click();
  await page.getByRole("button", { name: "开始面试", exact: true }).click();
  return { ctx, page };
}
async function probe(page: Page) {
  return page.evaluate(() => {
    const p = (window as unknown as { __entryProbe: { calls: number; clickCalls: number; failures: string[]; tracks: MediaStreamTrack[]; clones: MediaStreamTrack[] } }).__entryProbe;
    return { calls: p.calls, clickCalls: p.clickCalls, failures: p.failures, tracks: p.tracks.map(t => ({ kind: t.kind, state: t.readyState })),
      clones: p.clones.map(t => ({ kind: t.kind, state: t.readyState })),
      ws: JSON.parse(sessionStorage.getItem("__functionalRelayConnections") ?? "[]") };
  });
}
async function ready(page: Page) {
  await page.getByText("REC", { exact: true }).waitFor({ timeout: 15000 }).catch(async error => {
    console.error("ENTRY NOT READY", await page.locator("body").innerText(), await probe(page));
    throw error;
  });
  await page.waitForFunction(() => !(document.body.textContent ?? "").includes("正在连接面试，连接成功后会自动开始。"));
  await page.waitForFunction(() => !document.body.textContent?.includes("取消静音"));
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("__functionalRelaySentMessages") ?? "[]")
    .some((message: { type?: string }) => message.type === "audio"), undefined, { timeout: 10000 });
}
async function evidence(page: Page, name: string) {
  assert.equal(await page.evaluate(() => innerWidth), 390, "real CSS mobile viewport, not desktop auto-shrinking");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  writeFileSync(resolve(output, `${name}.json`), JSON.stringify({ ...(await probe(page)), text: await page.locator("body").innerText() }, null, 2));
}

test("E01/E05/E06: one click requests audio and video once and enters Q1", async () => {
  const { ctx, page } = await open("normal");
  try {
    await ready(page);
    const result = await probe(page);
    assert.equal(result.clickCalls, 1);
    assert.equal(result.calls, 1);
    assert.equal(result.ws.length, 1);
    assert.deepEqual(result.tracks.map(t => t.kind).sort(), ["audio", "video"]);
    assert.equal(await page.getByRole("button", { name: "开始面试", exact: true }).count(), 0);
    await page.getByText("第 1 / 8 题", { exact: true }).waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("video"))
      .some(video => video.videoWidth > 0 && video.readyState >= 2 && !video.paused));
    await page.getByText(/^0:0[1-9]$/, { exact: true }).first().waitFor({ timeout: 10000 });
    await evidence(page, "normal");
  } finally { await ctx.close(); }
});

test("E02: pending permission has accurate persistent guidance, late grant automatically continues", async () => {
  const { ctx, page } = await open("pending");
  try {
    await page.getByTestId("entry-status").getByText(/尚未获得/).waitFor({ timeout: 12000 });
    assert.equal((await probe(page)).ws.length, 0);
    const box = await page.getByTestId("entry-status").boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 844, "guidance must be inside mobile viewport");
    assert.equal((await page.locator("body").innerText()).includes("需要几秒钟"), false);
    await evidence(page, "pending");
    await page.evaluate(() => (window as unknown as { __entryProbe: { finish: () => void } }).__entryProbe.finish());
    await ready(page);
    assert.equal((await probe(page)).calls, 1);
  } finally { await ctx.close(); }
});

test("E03/E04: denied permission stays visible without repeated prompts and grant automatically resumes", async () => {
  const { ctx, page } = await open("denied");
  try {
    await page.getByTestId("entry-status").getByText(/浏览器尚未允许/).waitFor();
    await page.waitForTimeout(6500);
    assert.equal((await probe(page)).calls, 1);
    assert.equal(await page.getByTestId("entry-status").isVisible(), true);
    await evidence(page, "denied");
    await page.evaluate(() => { const p = (window as unknown as { __entryProbe: { mode: string; grant: () => void } }).__entryProbe; p.mode = "normal"; p.grant(); });
    await ready(page);
    assert.equal((await probe(page)).calls, 2);
    assert.equal((await probe(page)).ws.length, 1);
  } finally { await ctx.close(); }
});

test("E04/E05: confirmed grant replaces a stale request, late old stream is stopped", async () => {
  const { ctx, page } = await open("stale");
  try {
    await page.getByTestId("entry-status").getByText(/尚未获得/).waitFor({ timeout: 12000 });
    await page.evaluate(() => (window as unknown as { __entryProbe: { grant: () => void } }).__entryProbe.grant());
    await ready(page);
    await page.evaluate(() => (window as unknown as { __entryProbe: { finish: () => void } }).__entryProbe.finish());
    await page.waitForFunction(() => (window as unknown as { __entryProbe: { tracks: MediaStreamTrack[] } }).__entryProbe.tracks.length === 4);
    const result = await probe(page);
    assert.equal(result.calls, 2);
    assert.equal(result.ws.length, 1);
    assert.deepEqual(result.tracks.slice(2).map(t => t.state), ["ended", "ended"]);
    await evidence(page, "recovered");
  } finally { await ctx.close(); }
});

test("E03: missing devices have persistent candidate-facing guidance", async () => {
  const { ctx, page } = await open("missing");
  try {
    await page.getByTestId("entry-status").getByText(/当前浏览器无法使用/).waitFor();
    assert.equal((await probe(page)).ws.length, 0);
    await evidence(page, "missing");
  } finally { await ctx.close(); }
});

test("E05: leaving during permission wait stops a late stream and never opens a relay", async () => {
  const { ctx, page } = await open("pending");
  try {
    await page.getByTestId("entry-status").waitFor();
    await page.evaluate(() => (window as unknown as { __functionalUnmount: () => void }).__functionalUnmount());
    await page.evaluate(() => (window as unknown as { __entryProbe: { finish: () => void } }).__entryProbe.finish());
    await page.waitForFunction(() => (window as unknown as { __entryProbe: { tracks: MediaStreamTrack[] } }).__entryProbe.tracks.length === 2);
    const result = await probe(page);
    assert.deepEqual(result.tracks.map(t => t.state), ["ended", "ended"]);
    assert.equal(result.ws.length, 0);
  } finally { await ctx.close(); }
});

test("E05: leaving a connected interview releases the original device streams", async () => {
  const { ctx, page } = await open("normal");
  try {
    await ready(page);
    await page.evaluate(() => (window as unknown as { __functionalUnmount: () => void }).__functionalUnmount());
    const result = await probe(page);
    assert.deepEqual(result.tracks.map(t => t.state), ["ended", "ended"]);
    assert.equal(result.clones.length, 2);
    assert.ok(result.clones.every(t => t.state === "ended"), "capture and recording clones must also stop");
  } finally { await ctx.close(); }
});

test("E12: background recovery signals do not duplicate a pending permission or a connected session", async () => {
  const { ctx, page } = await open("pending");
  try {
    await page.getByTestId("entry-status").getByText(/尚未获得/).waitFor({ timeout: 12000 });
    const signal = async () => page.evaluate(() => {
      // Synthetic lifecycle signals exercise our handlers, not OS suspension.
      for (let i = 0; i < 5; i++) {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
      }
    });
    await signal();
    await page.waitForTimeout(300);
    assert.equal((await probe(page)).calls, 1);
    assert.equal((await probe(page)).ws.length, 0);
    await page.evaluate(() => (window as unknown as { __entryProbe: { finish: () => void } }).__entryProbe.finish());
    await ready(page);
    await signal();
    await page.waitForTimeout(300);
    const result = await probe(page);
    assert.equal(result.calls, 1);
    assert.equal(result.ws.length, 1);
    assert.ok(result.tracks.every(track => track.state === "live"));
    await evidence(page, "lifecycle-signals");
  } finally { await ctx.close(); }
});

test("E13: browsers without permission queries recover denied media on focus without another start button", async () => {
  const { ctx, page } = await open("denied");
  try {
    await page.getByTestId("entry-status").getByText(/浏览器尚未允许/).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "permissions", { configurable: true, value: undefined });
      (window as unknown as { __entryProbe: { mode: string } }).__entryProbe.mode = "normal";
      window.dispatchEvent(new Event("focus"));
    });
    await ready(page);
    const result = await probe(page);
    assert.equal(result.calls, 2);
    assert.equal(result.ws.length, 1);
    assert.equal(await page.getByRole("button", { name: "开始面试", exact: true }).count(), 0);
    await evidence(page, "permission-query-unavailable");
  } finally { await ctx.close(); }
});

test("E14: relay construction failure recovers on online without requesting devices again", async () => {
  const { ctx, page } = await open("pending");
  try {
    await page.evaluate(() => {
      const state = { offline: true, attempts: 0 };
      Object.assign(window, { __networkProbe: state });
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
          state.attempts++;
          if (state.offline) throw new DOMException("Injected local network failure", "NetworkError");
          return Reflect.construct(target, args);
        },
      });
      (window as unknown as { __entryProbe: { finish: () => void } }).__entryProbe.finish();
    });
    await page.waitForFunction(() => (window as unknown as { __networkProbe: { attempts: number } }).__networkProbe.attempts >= 3);
    await page.waitForTimeout(500);
    assert.equal((await probe(page)).calls, 1);
    assert.equal((await probe(page)).ws.length, 0);
    await evidence(page, "relay-offline");
    await page.evaluate(() => {
      (window as unknown as { __networkProbe: { offline: boolean } }).__networkProbe.offline = false;
      window.dispatchEvent(new Event("online"));
    });
    await ready(page);
    assert.equal((await probe(page)).calls, 1);
    assert.equal((await probe(page)).ws.length, 1);
    await evidence(page, "relay-online-recovered");
  } finally { await ctx.close(); }
});
