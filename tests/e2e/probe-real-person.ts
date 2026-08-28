// 真人模拟面试:完全自主投递+以候选人身份逐题作答(王总 2026-08-22)
// 不打印简历个人字段;报告只含题目与行为观察。
import { chromium, type Page } from "@playwright/test";
import {
  assertProductionWriteApproval,
  getApprovedPosition,
  loadApprovedResume,
} from "./helpers/apply";

const API = process.env.HR_API_BASE || "";
const INDEX = Number(process.env.RESUME_INDEX);
const LOG: string[] = [];
function log(line: string) {
  LOG.push(line);
  console.log(line);
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
  // 轮询邀请
  const token = payload.application_token;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = (await (
      await fetch(`${API}/v1/recruit/application/status?token=${encodeURIComponent(token)}`)
    ).json()) as { invite_url?: string | null };
    if (st.invite_url) {
      log(`投递成功 → 面试就绪(候选人 ${payload.candidate_id}, 岗位 ${positionName})`);
      return st.invite_url;
    }
  }
  throw new Error("invite timeout");
}

// ── 按题目关键词组织候选人式回答(基于简历真实经历,不泄露脱敏字段) ──
function answerFor(qText: string): string {
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

async function chatAnswer(page: Page, text: string) {
  await page.locator('[data-tour="voice-chat"] button').click();
  const input = page.getByRole("textbox");
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(text);
  await input.press("Enter");
  await page.waitForTimeout(800);
  await page.locator('[data-tour="voice-chat"] button').click(); // 收起聊天,露出中央按钮
}

async function lastAiText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("p"));
    const texts = nodes.map((n) => n.textContent || "").filter((s) => s.length > 20);
    return texts.length ? texts[texts.length - 1] : "";
  });
}

(async () => {
  assertProductionWriteApproval();
  const chosen = await getApprovedPosition();
  log(`选择岗位: ${chosen.name}`);
  const inviteUrl = await applyResume(chosen.id, chosen.name);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();

  // 拦截 getByToken,拿到全部题目文本
  let questions: string[] = [];
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
              order: Number(dig(it, ["order"]) ?? 0),
            }))
            .filter((it) => it.text)
            .sort((a, b) => a.order - b.order)
            .map((it) => it.text);
        }
      }
    } catch { /* ignore */ }
  });

  await page.goto(inviteUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[role="checkbox"]').click();
  await page.locator('button:has-text("开始面试")').click();
  await page.waitForFunction(
    () => document.body.innerText.includes("第 1 / 8 题"),
    undefined,
    { timeout: 120_000 },
  );
  log("面试已开始,开始逐题作答…");

  for (let q = 0; q < 8; q++) {
    // 等本题出现(切题后)
    await page.waitForFunction(
      ({ n }) => document.body.innerText.includes(`第 ${n} / 8 题`),
      { n: q + 1 },
      { timeout: 120_000 },
    );
    await page.waitForTimeout(2500);
    // 快速开始不等待 Q3-Q8 全部生成；做到某一题时只等待该题到达。
    const questionDeadline = Date.now() + 180_000;
    while (questions.length <= q && Date.now() < questionDeadline) {
      await page.waitForTimeout(500);
    }
    const qText = questions[q];
    if (!qText) throw new Error(`第 ${q + 1} 题在 180 秒内未生成`);
    if (questions.length > 8) throw new Error(`题目超过 8 道，实际为 ${questions.length}`);
    log(`\n── 第 ${q + 1} 题: ${qText.slice(0, 110)}`);

    let followUps = 0;
    let answered = false;
    let lastAiSeen = "";
    while (!answered && followUps <= 2) {
      const answer = followUps === 0 ? answerFor(qText) : "我再补充一点：" + answerFor(qText).slice(0, 120);
      await chatAnswer(page, answer);
      log(`  已作答(第 ${followUps + 1} 轮)…`);
      // 最后一题：CTA 按设计不出现，答完即进入自然收尾等待。
      if (q === 7) {
        answered = true;
        break;
      }
      // 等 AI 回应完(中央下一题按钮出现)
      const cta = page.locator(
        '[data-tour="voice-status"]:has-text("本题答完了就点这里") button:has-text("下一题")',
      );
      try {
        await cta.waitFor({ state: "visible", timeout: 150_000 });
      } catch {
        log("  ⚠️ 150s 未出现下一题按钮,尝试底部按钮推进");
        await page.locator('[data-tour="voice-progress"] button').nth(1).click();
        followUps += 1;
        continue;
      }
      // 判断 AI 是否又追问
      const last = await lastAiText(page);
      if (last === lastAiSeen) {
        answered = true;
        break;
      }
      if (followUps < 2 && /？|\?/.test(last) && !/下一题|进入下一题/.test(last)) {
        lastAiSeen = last;
        followUps += 1;
        log(`  AI 追问: ${last.slice(0, 60)}… 继续回答`);
        continue;
      }
      answered = true;
    }

    if (q < 7) {
      await page
        .locator('[data-tour="voice-status"]:has-text("本题答完了就点这里") button:has-text("下一题")')
        .click();
      await page.screenshot({ path: `screenshots/sim-q${q + 1}.png` });
    } else {
      if (questions.length !== 8) {
        throw new Error(`最终题目数量必须恰好为 8，实际为 ${questions.length}`);
      }
      log("第 8 题答完，等待最终核验或自然收尾…");
      await page.waitForFunction(
        () => document.body.innerText.includes("测试已完成"),
        undefined,
        { timeout: 240_000 },
      );
      log("✅ 面试自然收尾,出现完成页");
      await page.screenshot({ path: "screenshots/sim-q8-completed.png", fullPage: true });
      await browser.close();
      log("=== 模拟结束(自然完成) ===");
      return;
    }
  }

  throw new Error("八题完成后未进入完成页");
})().catch((e) => {
  console.error("SIM_FAIL:", e.message);
  process.exit(1);
});
