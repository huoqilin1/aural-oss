// 真人模拟面试:完全自主投递+以候选人身份逐题作答(王总 2026-08-22)
// 不打印简历个人字段;报告只含题目与行为观察。
//
// 2026-08-24 重构:
//  - 前置门禁:依赖/路径/浏览器能力预检,坏环境 15 秒内失败;
//  - 状态落盘:投递成功即写 run-<id>.json(候选人与岗位 id),每里程碑更新;
//  - 快速失败:Q1 到达 15s、CTA 30s、收尾 60s(不再有 120s/150s/240s 长等);
//  - 输入回执:打字后必须出现消息气泡,未送达即失败(复现"发消息被静默丢弃");
//  - 追问预算双核验:逐题计数 + 全程 ≤3,收尾时再断言题目恰好 8 道。
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  assertProductionWriteApproval,
  getApprovedPosition,
  loadApprovedResume,
} from "./helpers/apply";

const API = process.env.HR_API_BASE || "";
const INDEX = Number(process.env.RESUME_INDEX);
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR || join(process.cwd(), "screenshots");
const RUN_ID = randomUUID().slice(0, 8);
const STATE_FILE = join(SHOT_DIR, `run-${RUN_ID}.json`);
const LOG: string[] = [];
let state: Record<string, unknown> = { run_id: RUN_ID };

function log(line: string) {
  LOG.push(line);
  console.log(line);
}

function saveState(patch: Record<string, unknown>) {
  state = { ...state, ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function dig(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else return undefined;
  }
  return cur;
}

/** ── 前置门禁:所有可预检的失败都在 15 秒内暴露,不消耗一次真实投递 ── */
async function preflight() {
  const t0 = Date.now();
  if (!API) throw new Error("HR_API_BASE 未设置(前置门禁)");
  if (Number.isNaN(INDEX) || INDEX < 0) throw new Error("RESUME_INDEX 未设置(前置门禁)");
  mkdirSync(SHOT_DIR, { recursive: true });
  const probe = join(SHOT_DIR, `.write-probe-${RUN_ID}`);
  writeFileSync(probe, "ok");
  readFileSync(probe, "utf-8");

  for (const mod of ["docx", "@playwright/test"]) {
    await import(mod).catch(() => {
      throw new Error(`依赖 ${mod} 不可用(前置门禁:先 npm install tests/e2e)`);
    });
  }
  const health = await fetch(`${API}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) {
    throw new Error(`HR 健康检查 ${health.status}(前置门禁)`);
  }
  log(`HR 可达(${health.status}),依赖与截图目录就绪,耗时 ${Date.now() - t0}ms`);
}

async function applyResume(positionId: number, positionName: string) {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const text = loadApprovedResume(INDEX).text || "";
  const paragraphs: Array<InstanceType<typeof Paragraph>> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    paragraphs.push(
      new Paragraph({
        heading: line.length <= 30 && !/[，。；：、]/.test(line) ? HeadingLevel.HEADING_2 : undefined,
        children: [new TextRun(line)],
      }),
    );
  }
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
  const form = new FormData();
  form.append("position", positionName);
  form.append("position_id", String(positionId));
  form.append("idempotency_key", Math.random().toString(36).slice(2) + Date.now().toString(36));
  form.append(
    "resume",
    new Blob([Uint8Array.from(buffer).buffer], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "resume-sim.docx",
  );
  const resp = await fetch(`${API}/v1/recruit/apply`, { method: "POST", body: form });
  const payload = (await resp.json()) as {
    success?: boolean;
    candidate_id?: number;
    application_token?: string;
  };
  if (!payload.success || !payload.candidate_id || !payload.application_token) {
    throw new Error("apply failed");
  }
  // 投递成功立即落盘;邀请 URL 只进本地状态文件,不打日志。
  saveState({
    phase: "applied",
    position_id: positionId,
    candidate_id: payload.candidate_id,
    applied_at: new Date().toISOString(),
  });
  // 轮询邀请(单次 ≤30s + 15s 余量;P95 ≤15s)
  const token = payload.application_token;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = (await (
      await fetch(`${API}/v1/recruit/application/status?token=${encodeURIComponent(token)}`)
    ).json()) as { invite_url?: string | null };
    if (st.invite_url) {
      saveState({ phase: "invite_ready", invite_url: st.invite_url });
      log(`投递成功 → 面试就绪(候选人 ${payload.candidate_id}, 岗位 ${positionName})`);
      return st.invite_url;
    }
  }
  throw new Error(`invite timeout (${45}s)`);
}

// ── 按题目关键词组织候选人式回答(基于简历真实经历,不泄露脱敏字段) ──
/** 多样本质量验收(质量手册 §预设疑点):按 ANSWER_MODE 变换基线回答。
 *  baseline  严格按简历可知事实回答(不夸大)。
 *  vague_we  本人贡献模糊:贡献句一律改"我们",直到 AI 核验本人角色。
 *  timeline  时间线矛盾:自述中植入一段与简历冲突的日期(预录盲底)。
 * 预设内容只写入本地 state 文件(解盲用),不进系统。 */
const ANSWER_MODE = process.env.ANSWER_MODE || "baseline";
const PLANTED_FAW_RECORD: Record<string, string> = {
  baseline: "无预设疑点(一致基线)",
  vague_we: "本人贡献模糊:所有贡献表述用\"我们\",不主动区分本人角色",
  timeline: "时间线矛盾:自述称商汤经历为 2018-2020 年(与简历时间线冲突)",
};
function applyAnswerMode(text: string): string {
  if (ANSWER_MODE === "vague_we") {
    return text
      .replace(/我本人/g, "我们")
      .replace(/我(?=负责|参与|搭建|做了|完成|独立|重点保障|自学)/g, "我们")
      .replace(/我把/g, "我们把");
  }
  if (ANSWER_MODE === "timeline") {
    return text.replace("最近在商汤科技", "2018到2020年间我在商汤科技");
  }
  return text;
}

function answerFor(qText: string): string {
  if (ANSWER_MODE === "anchor") return answerFromAnchor(qText);
  return applyAnswerMode(answerForBaseline(qText));
}

/** 锚点式如实回答(真实简历样本):只确认题干引用的简历锚点并如实说明
 *  参与方式,不虚构指标与细节——口径与数据"以记录为准"。 */
function answerFromAnchor(qText: string): string {
  if (/自我介绍/.test(qText)) {
    return "我的经历简历里写得更完整，这里简要说明：按简历时间线我先后有几段岗位经历，与应聘岗位最相关的是简历里重点描述的那段。具体项目内容我结合后面每题引用的简历条目来回答，以简历记录为准。";
  }
  if (/提问|想问/.test(qText)) {
    return "我想了解团队目前的工作节奏和这个岗位入职后前三个月的主要目标，谢谢。";
  }
  const anchors = [...qText.matchAll(/“([^”]{6,80})”/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (anchors.length) {
    return `简历里写的"${anchors[0]}"是我的真实经历。我在其中按分工承担了自己负责的部分，配合团队按期交付；更细的指标口径和数据以当时的记录为准，这里不凭印象报数。`;
  }
  return "这一块我以简历记录为准：相关经历在简历里有对应描述，我负责的是分工内的部分，结果按期完成。";
}

function answerForBaseline(qText: string): string {
  const t = qText;
  if (/自我介绍/.test(t)) {
    return "您好，我是一名测试开发工程师，有十六年的软件测试经验。最近在商汤科技负责智能遥感解译平台 SenseRemote Layers 的测试开发，包括接口测试、功能测试和自动化框架的搭建维护；之前分别在联想做过商用客户中台 UCP 项目的接口自动化框架从零搭建，在爱奇艺负责大播放 SDK 的手工与自动化测试。技术栈上熟练 Python、Selenium、Pytest、Requests 接口自动化、Jenkins 持续集成和 Docker，也熟悉 SQL 和 Linux。";
  }
  if (/岗位|职责|工作目标/.test(t)) {
    return "我最核心的职责是保障产品交付质量并把重复劳动自动化。以 SenseRemote Layers 为例：我参与需求评审、设计测试用例、完成接口与功能测试，同时搭建了 UI 自动化框架，把热点功能的回归从手工点检变成定时自动执行，覆盖率明显提升，人力从每周两天回归降到每天自动跑一轮，发现问题提前到发布前。";
  }
  if (/协作|沟通|跨团队|分歧/.test(t)) {
    return "在联想 UCP 项目里，测试需要和产品、前后端开发以及外部十几个系统联调。我习惯把问题分类：需求理解偏差当面对齐并落成文档，缺陷用 jira 带复现步骤和日志推动修复，联调问题先定位到是哪一方，再约相关方一起过，避免来回踢皮球。印象最深的是 China Migration 这种重点项目，靠每日站会同步进度，最后按期交付。";
  }
  if (/经历|项目|负责/.test(t)) {
    return "讲一段最相关的经历：在商汤 SenseRemote Layers 项目，我负责从测试计划、用例设计到执行的完整链路。这个平台是 AI 遥感解译算法生产平台，涉及数据入库、样本生产、模型训练、智能解译全流程。我重点保障了接口层和模型任务调度链路的稳定性，搭建了基于 Python+Requests+Pytest 的接口自动化框架，支持数据驱动和失败重试，还做了测试报告自动生成，团队每个迭代能提前一天完成回归。";
  }
  if (/难点|问题|解决|复杂|异常|故障|排查/.test(t)) {
    return "讲一个具体的：自动化用例上线初期通过率只有八成五，大多是环境依赖和偶发超时。我做了三件事：一是用例数据驱动化，把环境参数和测试数据分离；二是加失败自动重试和错误截图、日志归档；三是用 jenkins 分布式执行并分析 flaky 用例，把偶发问题归类成代码缺陷和环境问题分别推动。三个月后通过率稳定在九成九，定时回归从需要人盯着变成可以完全自动。";
  }
  if (/AI|人工智能|大模型|智能/.test(t)) {
    return "我在 AI 项目的测试里，本身就是把 AI 用在工作流中：用脚本自动构造训练样本和接口测试数据，用自动化分析失败日志；同时我在学习用 AI 辅助生成测试用例和代码审查。对这个岗位，我认为 AI 能力在测试领域可以落在三处：智能生成用例、自动分析失败根因、以及测试报告的自然语言总结，让质量数据直接变成可读的结论。";
  }
  if (/学习|成长|新技术|转型/.test(t)) {
    return "我的路径是从手工测试转向自动化再转向测试开发：早期在爱奇艺做手工和兼容性测试，后来在联想自学 Python 和框架，独立搭了接口自动化；在商汤接触 AI 平台后，开始系统学习模型训练流水线和 AI 应用的质量保障。我的学习方法是项目驱动，带着问题学，学完立刻落地到框架里，所以每段经历都沉淀成了可复用的资产。";
  }
  if (/为什么|动机|规划|稳定|期望/.test(t)) {
    return "选择这个岗位，是因为我过去四年在 AI 平台项目里积累的测试和自动化经验正好能用上，而我对 AI 应用落地的质量保障有持续的兴趣；加上我有十六年稳定在一线工作的记录，最长一段在一家公司干了六年，我看重的是长期把事情做好，而不是频繁跳槽。";
  }
  if (/提问|问题.*(问|想)|想问/.test(t)) {
    return "我想了解两个问题：一是团队目前的自动化测试基建到什么程度，是否有统一的用例管理平台；二是这个岗位后续是否会参与 AI 辅助测试工具的建设，我在这方面有比较明确的兴趣。";
  }
  return "结合我负责过的 AI 平台和自动化框架经历：我理解质量的核心是提前发现问题并让回归自动化。以商汤 SenseRemote Layers 为例，我会先梳理核心链路，设计针对性的用例，再逐步把高频回归自动化，用数据说话推动质量提升。";
}

/** 发送前先等输入就绪;发出后必须看到消息气泡(即回执),否则算失败。
 *  复现过生产故障:连接未就绪时 Enter 被静默吞掉,消息永远没有送达。
 *  注意:ui/Input 未显式传 type,渲染出的 input 没有 type 属性,
 *  不能用 input[type="text"] 选择器(会永远匹配为空导致假超时)。 */
async function chatAnswer(page: Page, text: string) {
  // 像真实候选人一样等 AI 说完再作答:AI 播题(TTS)期间发出的 chat 消息
  // 会被中继记录但不处理(生产实测"答后静默 90s"),状态标签回到
  // "正在听取回答"再发送。面试已结束/已断开时直接失败。
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      if (t.includes("面试已结束")) return false;
      return t.includes("正在听取回答");
    },
    undefined,
    { timeout: 60_000 },
  ).catch(() => {
    throw new Error("60s 内未进入可作答状态(未出现\"正在听取回答\")");
  });
  await page.locator('[data-tour="voice-chat"] button').click();
  const input = page.getByRole("textbox");
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
    );
    const el = els.find((e) => e.offsetParent !== null);
    return !!el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  }, undefined, { timeout: 15_000 });
  await input.fill(text);
  // 回执判定必须用"出现次数递增":同一开头的回答会重复出现(如追问轮的
  // "我再补充一点:…"前缀),只查 includes 会把旧气泡误当本次回执,
  // 导致发送实际被吞却以为已送达(生产实测踩过)。
  const needle = text.slice(0, 10);
  const before = await countNeedle(page, needle);
  await input.press("Enter");
  // 切题过渡期/中继短暂重连中的发送会被拦截,提示"正在切换题目"/
  // "连接尚未就绪"/"消息未能送达"且输入框保留原文(设计行为);
  // 看到拦截提示即等待后重按 Enter;横幅被 5s 自动清除后按较长间隔兜底重发。
  const deadline = Date.now() + 45_000;
  let lastTry = Date.now();
  for (;;) {
    const { seen, blocked } = await page.evaluate((n) => {
      const t = document.body.textContent || "";
      return {
        seen: t.split(n).length - 1,
        blocked:
          t.includes("正在切换题目")
          || t.includes("连接尚未就绪")
          || t.includes("消息未能送达"),
      };
    }, needle);
    if (seen > before) break;
    if (Date.now() > deadline) {
      throw new Error("消息未在 45 秒内出现(回执缺失):发送被吞或未送达");
    }
    const sinceTry = Date.now() - lastTry;
    if ((blocked && sinceTry > 2_500) || sinceTry > 8_000) {
      await input.press("Enter").catch(() => {});
      lastTry = Date.now();
    }
    await page.waitForTimeout(500);
  }
  sentTexts.push(text.slice(0, 24));
  await page.waitForTimeout(500);
  await page.locator('[data-tour="voice-chat"] button').click(); // 收起聊天,露出中央按钮
}

async function countNeedle(page: Page, needle: string): Promise<number> {
  return page.evaluate((n) => (document.body.textContent || "").split(n).length - 1, needle);
}

/** 我们已发送并确认送达的回答前缀(用于把候选人自己的气泡从 AI 话术中排除)。 */
const sentTexts: string[] = [];

async function lastAiText(page: Page): Promise<string> {
  // 注意:回调内不得出现"具名箭头绑定"(const f = (x) => …)——tsx 的
  // keepNames 会注入浏览器不存在的 __name 助手;只用内联匿名回调。
  // 引号/空白归一化:AI 复述我们的回答时常包裹引号。
  return page.evaluate((mine) => {
    const strip = /[\s\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f'"]/g;
    const mineNorm = mine.map((m) => m.replace(strip, ""));
    const nodes = Array.from(document.querySelectorAll("p"));
    const texts = nodes
      .map((n) => (n.textContent || "").replace(strip, ""))
      .filter((s) => s.length > 20)
      .filter((s) => !mineNorm.some((m) => s.startsWith(m)));
    return texts.length ? texts[texts.length - 1] : "";
  }, mineSafe());
}
function mineSafe(): string[] {
  return sentTexts.map((s) => s.slice(0, 12));
}

async function waitQuestionLoaded(
  questions: Array<{ text: string; type: string; desc: string }>,
  q: number,
) {
  const deadline = Date.now() + 30_000; // 单题就绪 ≤30s(进度生成;Q2 在 Q1 结束前)
  while (mainsOf(questions).length <= q && Date.now() < deadline) {
    await pageWaitTimeout(500);
  }
  if (mainsOf(questions).length <= q) throw new Error(`第 ${q + 1} 题在 30 秒内未生成`);
}

/** 收尾行(候选人反问环节)与追问行不计入计分主问题。 */
function isClosingRow(row: { type: string; desc: string; text?: string }): boolean {
  return (
    row.type === "closing"
    || /candidate_questions/.test(row.desc)
    || /候选人提问|反问|你有什么.{0,6}(问题|想问)/.test(row.text || "")
  );
}

function mainsOf(questions: Array<{ text: string; type: string; desc: string }>) {
  return questions.filter((row) => !isClosingRow(row) && row.type !== "follow_up");
}

function pageWaitTimeout(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 点"下一题"前必须等按钮可用(不允许对禁用按钮点击) */
async function clickNext(page: Page) {
  const cta = page.locator(
    '[data-tour="voice-status"]:has-text("本题答完了就点这里") button:has-text("下一题")',
  );
  await cta.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("下一题"));
    return !!btn && !btn.hasAttribute("disabled");
  }, undefined, { timeout: 15_000 });
  await cta.click();
}

/** 官网 UI 真实投递模式:APPLY_VIA=careers_ui + RESUME_FILE=<文件路径>。
 *  与 API 投递互斥;文件必须经 PRODUCTION_RESUME_FILE_APPROVED=YES 且
 *  PRODUCTION_RESUME_FILE_SHA256 等于文件字节指纹(失败关闭)。 */
const APPLY_VIA = process.env.APPLY_VIA || "api";
const RESUME_FILE = process.env.RESUME_FILE || "";
function assertResumeFileApproval(fileBytes: Buffer) {
  if (process.env.PRODUCTION_RESUME_FILE_APPROVED !== "YES") {
    throw new Error("careers_ui 投递缺少 PRODUCTION_RESUME_FILE_APPROVED=YES 明确授权");
  }
  const approved = String(process.env.PRODUCTION_RESUME_FILE_SHA256 || "").toLowerCase();
  const actual = createHash("sha256").update(fileBytes).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(approved) || approved !== actual) {
    throw new Error("简历文件指纹与当前批准不一致(失败关闭)");
  }
}

async function applyViaCareersUi(page: Page, positionName: string | null) {
  const fileBytes = readFileSync(RESUME_FILE);
  assertResumeFileApproval(fileBytes);
  await page.goto("https://ai.yifx.vip/careers", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);
  if (positionName) {
    await page.locator("select").first().selectOption({ label: positionName });
  }
  await page.locator("input[type=file]").first().setInputFiles(RESUME_FILE);
  await page.waitForTimeout(2000);
  const continueExisting = page.getByRole("button", { name: /继续上次未完成的面试/ }).first();
  const submitNew = page.getByRole("button", { name: /提交简历并进入面试须知|开始面试/ }).first();
  await Promise.any([
    continueExisting.waitFor({ state: "visible", timeout: 45_000 }),
    submitNew.waitFor({ state: "visible", timeout: 45_000 }),
  ]);
  const submit = (await continueExisting.isVisible().catch(() => false))
    ? continueExisting
    : submitNew;
  const tClick = Date.now();
  await submit.click();
  // 官网投递后直达须知页;P95≤15s、单次≤30s 为申请→邀请契约。
  await page.getByText(/我已阅读并同意以上面试须知/).waitFor({ state: "visible", timeout: 120_000 });
  const readyMs = Date.now() - tClick;
  saveState({
    phase: "careers_applied",
    resume_file_hash: createHash("sha256").update(fileBytes).digest("hex").slice(0, 16),
    careers_ready_ms: readyMs,
    applied_at: new Date().toISOString(),
  });
  log(`官网投递成功 → 须知页就绪(${(readyMs / 1000).toFixed(1)}s)`);
}

(async () => {
  await preflight();
  assertProductionWriteApproval();
  const chosen = await getApprovedPosition();
  const useCareersUi = APPLY_VIA === "careers_ui";
  if (useCareersUi && !RESUME_FILE) throw new Error("careers_ui 投递必须设置 RESUME_FILE");
  log(`选择岗位: ${chosen.name}${useCareersUi ? "(官网 UI 投递)" : ""}`);
  const inviteUrl = useCareersUi ? null : await applyResume(chosen.id, chosen.name);

  let browser: Browser | null = null;
  try {
    const tLaunch = Date.now();
    browser = await chromium.launch({
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const page = await browser.newPage();
    (globalThis as { __probePage?: Page }).__probePage = page;

    // 浏览器能力探测(15 秒内失败):页面脚本与 DOM 查询可用。
    await page.setContent("<p id='cap'>ok</p>");
    const capOk = await page.evaluate(() => !!document.querySelector("#cap")?.textContent);
    if (!capOk) throw new Error("浏览器能力探测失败(前置门禁)");
    log(`浏览器就绪,启动≈${Date.now() - tLaunch}ms`);

    // 拦截 getByToken,拿到全部题目文本与类型(用于 8 题与追问预算双核验)。
    // 持久化计划含 8 道计分主问题 + 1 道候选人收尾行(oprun_dimension:
    // candidate_questions),主问题断言只针对主问题行。
    let questions: Array<{ text: string; type: string; desc: string }> = [];
    page.on("response", async (resp) => {
      if (!resp.url().includes("candidate.getByToken")) return;
      try {
        const body = (await resp.json()) as unknown;
        for (const env of Array.isArray(body) ? body : [body]) {
          const data = dig(env, ["result", "data", "json", "interview", "questions"]);
          if (Array.isArray(data)) {
            questions = data
              .map((it) => ({
                text: String(dig(it, ["text"]) ?? ""),
                type: String(
                  dig(it, ["questionType"]) ?? dig(it, ["type"]) ?? dig(it, ["kind"]) ?? "main",
                ).toLowerCase(),
                desc: String(dig(it, ["description"]) ?? ""),
                order: Number(dig(it, ["order"]) ?? 0),
              }))
              .filter((it) => it.text)
              .sort((a, b) => a.order - b.order);
          }
        }
      } catch { /* ignore */ }
    });

    saveState({
      phase: "opening",
      opened_at: new Date().toISOString(),
      answer_mode: ANSWER_MODE,
      planted_flaw: PLANTED_FAW_RECORD[ANSWER_MODE] || "unknown",
    });
    if (useCareersUi) {
      await applyViaCareersUi(page, process.env.POSITION_LABEL || null);
    } else {
      await page.goto(inviteUrl as string, { waitUntil: "domcontentloaded" });
    }
    await page.locator('[role="checkbox"]').click();
    await page.locator('button:has-text("开始面试")').click();
    // 快速失败:AI 问候 + Q1 到达 ≤15s(契约 start→问候 ≤10s)
    await page.waitForFunction(
      () => document.body.innerText.includes("第 1 / 8 题"),
      undefined,
      { timeout: 15_000 },
    );
    log("面试已开始,开始逐题作答…");
    saveState({ phase: "started", started_at: new Date().toISOString() });

    let totalFollowUps = 0;
    for (let q = 0; q < 8; q++) {
      // 等本题出现(切题后,Q2 必须在 Q1 结束前就绪)
      await page.waitForFunction(
        ({ n }) => document.body.innerText.includes(`第 ${n} / 8 题`),
        { n: q + 1 },
        { timeout: 30_000 },
      );
      await page.waitForTimeout(2500);
      await waitQuestionLoaded(questions, q);
      // 渐进出题:开场仅持久化 Q1+Q2,后续行随面试推进补齐;
      // 逐题只要求"当前题已就绪",恰好 8 道的断言留到最终核验。
      const mains = mainsOf(questions);
      if (mains.length < q + 1) {
        throw new Error(`第 ${q + 1} 题未就绪(主问题 ${mains.length} 道)`);
      }
      const qText = mains[q].text;
      const qType = mains[q].type;
      if (qType === "follow_up") throw new Error(`主问题位出现追问行(第 ${q + 1} 道, 类型 ${qType})`);
      log(`\n── 第 ${q + 1} 题: ${qText.slice(0, 110)}`);

      let followUps = 0;
      let answered = false;
      // 基线取本题题干;答后 AI 的新话术(追问)以此为参照。
      let lastAiSeen = qText;
      // 回答必须逐题唯一:中继会丢弃与前一轮完全相同的文本(生产实测
      // Q2/Q3 命中同一回答模板导致"答后静默 90s"),追加题号后缀防去重。
      const answerSuffix = `（第 ${q + 1} 题作答）`;
      while (!answered) {
        if (followUps > 2) throw new Error(`第 ${q + 1} 题追问超过 2 次`);
        const base = followUps === 0 ? answerFor(qText) : "我再补充一点：" + answerFor(qText).slice(0, 120);
        const answer = base + answerSuffix;
        await chatAnswer(page, answer);
        log(`  已作答(第 ${followUps + 1} 轮)…`);
        // 最后一题：CTA 按设计不出现，答完即进入自然收尾等待。
        if (q === 7) {
          answered = true;
          break;
        }
        // 答后三选一(生产实测:完整回答后 AI 常自动切题,CTA 只是可选加速器,
        // 且追问/下一题题干不一定带问号,不能靠"？"识别):
        //   1) 页面进入 第 q+2/8 题 → 已推进;
        //   2) AI 出现新话术(非按钮提示) → 追问,继续作答;
        //   3) CTA 可见 → 点击推进并等待切题。
        const nextIdxText = `第 ${q + 2} / 8 题`;
        const cta = page.locator(
          '[data-tour="voice-status"]:has-text("本题答完了就点这里") button:has-text("下一题")',
        );
        const deadline = Date.now() + 90_000;
        let moved: "advanced" | "followup" | null = null;
        while (Date.now() < deadline && !moved) {
          const body = await page.evaluate(() => document.body.innerText);
          if (body.includes(nextIdxText)) {
            moved = "advanced";
            break;
          }
          const last = await lastAiText(page);
          const isUiHint = !last || /本题答完了|下一题/.test(last);
          // AI 口播题干常带前缀(如"接下来第3个问题:"),用包含关系判回显;
          // last 与题干都做同样的引号/空白归一化后再比较。
          const normRe = /[\s\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f'"]/g;
          const qNorm = qText.replace(normRe, "");
          const isQuestionEcho =
            !!last
            && (last.includes(qNorm.slice(0, 12)) || qNorm.includes(last.slice(0, 12)));
          // 下一题题干可能先于页头出现(切题 TTS 早于 question_change 渲染):
          // 命中下一题文本时等待页头切题,不算当前题的追问。
          // 渐进出题会在此轮询期间补齐下一题,须实时重算。
          const nextRow = mainsOf(questions)[q + 1];
          const nextSeeded = nextRow ? nextRow.text.replace(normRe, "") : "";
          const isNextQuestionText =
            !!last
            && !!nextSeeded
            && (last.includes(nextSeeded.slice(0, 12)) || nextSeeded.includes(last.slice(0, 12)));
          const asksSomething = !!last && /(？|\?|请|说说|讲讲|讲一|聊聊|谈谈|展开|补充|具体|如何|为什么|什么|确认|举例|提到|讲到|描述)/.test(last);
          if (last && last !== lastAiSeen && !isUiHint && !isQuestionEcho && !isNextQuestionText && asksSomething && last.length > 15) {
            lastAiSeen = last;
            followUps += 1;
            log(`  AI 追问: ${last.slice(0, 60)}… 继续回答`);
            moved = "followup";
            break;
          }
          if (await cta.isVisible().catch(() => false)) {
            try {
              await clickNext(page);
            } catch { /* CTA 消失则回到轮询等自动切题 */ }
            const t2 = Date.now() + 20_000;
            while (Date.now() < t2) {
              const b2 = await page.evaluate(() => document.body.innerText);
              if (b2.includes(nextIdxText)) break;
              await page.waitForTimeout(800);
            }
          }
          if (!moved) await page.waitForTimeout(1_000);
        }
        if (!moved) {
          // 停滞不一定是死局:可能是未识别的追问话术。预算内先补答一轮,
          // 仍然停滞才判失败。
          if (followUps < 2) {
            followUps += 1;
            log(`  ⚠️ 第 ${q + 1} 题 90s 无推进,按未识别追问补答一轮`);
            moved = "followup";
          } else {
            throw new Error(`第 ${q + 1} 题答后 90s 未推进(无自动切题、无 CTA、无追问)`);
          }
        }
        if (moved === "followup") continue;
        answered = true;
      }
      totalFollowUps += followUps;
      if (totalFollowUps > 3) {
        throw new Error(`追问预算超限: 全程 ${totalFollowUps} 次(允许 ≤3)`);
      }
      saveState({
        phase: `q${q + 1}_answered`,
        last_question_index: q,
        follow_ups_on_question: followUps,
        total_follow_ups: totalFollowUps,
      });

      if (q < 7) {
        await page.screenshot({ path: join(SHOT_DIR, `sim-q${q + 1}.png`) });
      } else {
        // 最终核验:全部行就位后,计分主问题必须恰好 8 道。
        if (mainsOf(questions).length !== 8) {
          throw new Error(
            `最终核验:计分主问题必须恰好 8 道,实际 ${mainsOf(questions).length}(原始行 ${questions.length})`,
          );
        }
        // 追问预算双核验:逐题计数 ≤3(0-2 正常 + 0-1 最终核验)
        if (totalFollowUps > 3) {
          throw new Error(`最终追问预算核验失败: ${totalFollowUps} > 3`);
        }
        log("第 8 题答完，等待收尾提问(候选人反问环节)…");
        // 收尾提问属设计环节:AI 问"你有什么想问的"需作答一次才能自然收尾。
        try {
          await page.waitForFunction(
            () => /你有什么.{0,8}(想问|问题)|有什么想问|提问/.test(document.body.innerText),
            undefined,
            { timeout: 40_000 },
          );
          await chatAnswer(page, answerFor("提问"));
          log("  已回答收尾提问");
        } catch {
          log("  40s 未出现收尾提问,按自然收尾处理");
        }
        // 静默确认("答完了吗?")出现时,像真实候选人一样显式说"没有了",
        // 命中中继的结束请求模式 → 告别 → 完成页。
        await page.waitForFunction(
          () => /答完了吗|还想补充|进入下一题/.test(document.body.innerText),
          undefined,
          { timeout: 60_000 },
        ).catch(() => { /* 未出现静默确认则直接尝试结束 */ });
        await chatAnswer(page, "没有了，我答完了，谢谢！");
        await page.waitForFunction(
          () => document.body.innerText.includes("面试已顺利完成"),
          undefined,
          { timeout: 90_000 },
        );
        log(`✅ 面试自然收尾,出现完成页(全程追问 ${totalFollowUps} 次)`);
        await page.screenshot({ path: join(SHOT_DIR, "sim-q8-completed.png"), fullPage: true });
        saveState({
          phase: "completed",
          completed_at: new Date().toISOString(),
          total_follow_ups: totalFollowUps,
        });
        log("=== 模拟结束(自然完成) ===");
        return;
      }
    }

    throw new Error("八题完成后未进入完成页");
  } catch (err) {
    // 失败截图必须在浏览器关闭前拍摄(finally 会先关浏览器)。
    try {
      const page = (globalThis as { __probePage?: Page }).__probePage;
      if (page) {
        await page.screenshot({ path: join(SHOT_DIR, `fail-${RUN_ID}.png`), fullPage: true });
      }
    } catch { /* 截图失败不影响失败上报 */ }
    throw err;
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
})().catch((e) => {
  saveState({ phase: "failed", error: e.message, failed_at: new Date().toISOString() });
  console.error(`SIM_FAIL: ${e.message}`);
  process.exit(1);
});
