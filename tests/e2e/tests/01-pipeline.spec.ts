import { test, expect, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyAndWaitForInvite,
  applyWithoutPosition,
  listOpenPositions,
  saveState,
  HR_API_BASE,
  RESUME_LIBRARY,
} from "../helpers/apply";

const RESUME_INDEX = Number(process.env.RESUME_INDEX);

test.describe.configure({ mode: "serial" });

test.describe("投递管线", () => {
  test("投递→面试就绪不超过 60 秒,岗位为真实在招岗位", async () => {
    test.skip(!RESUME_LIBRARY, "简历库不可用时跳过");
    const application = await applyAndWaitForInvite(RESUME_INDEX);
    saveState(application);
    console.log(
      `就绪耗时 ${application.readyElapsedMs / 1000}s, 岗位=${application.positionName}, 候选人=${application.candidateId}`,
    );
    expect(application.readyElapsedMs).toBeLessThan(60_000);
    expect(application.positionName).toBeTruthy();
    expect(application.positionName).not.toContain("数君");
  });

  test("不选岗位进不了面试:拦截并等待手动选择", async () => {
    test.skip(
      process.env.PRODUCTION_NEGATIVE_APPLY_APPROVED !== "YES",
      "新增第二条无岗申请必须单独批准",
    );
    test.skip(!RESUME_LIBRARY, "简历库不可用时跳过");
    const negativeIndex = Number(process.env.PRODUCTION_NEGATIVE_RESUME_INDEX);
    const { applicationToken } = await applyWithoutPosition(negativeIndex);

    // 简历解析完成后应转入"待手动选择",且拿不到面试邀请
    let sawNeedsSelection = false;
    for (let i = 0; i < 12; i++) {
      const status = (await (
        await fetch(
          `${HR_API_BASE}/v1/recruit/application/status?token=${encodeURIComponent(applicationToken)}`,
        )
      ).json()) as {
        ready?: boolean;
        invite_url?: string | null;
        position_resolution?: { status?: string };
      };
      if (status.position_resolution?.status === "needs_manual_selection") sawNeedsSelection = true;
      expect(status.invite_url, "未选岗位不得发放面试邀请").toBeNull();
      if (sawNeedsSelection) break;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    expect(sawNeedsSelection, "解析完成后应进入待手动选择状态").toBe(true);

    // 手动确认岗位后,面试正常就绪
    const positionId = Number(process.env.PRODUCTION_POSITION_ID);
    const positions = await listOpenPositions();
    const position = positions.find((row) => row.id === positionId);
    expect(position, `获批岗位 ID ${positionId} 必须仍在招聘`).toBeTruthy();
    const confirm = await fetch(`${HR_API_BASE}/v1/recruit/application/position/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: applicationToken, position_id: position!.id }),
    });
    expect(confirm.ok).toBe(true);
    const payload = (await confirm.json()) as { success?: boolean };
    expect(payload.success).toBe(true);
  });

  test("生成题目质量扫描:恰好八道计分题且 Q1 为自我介绍", async ({
    page,
  }) => {
    const stateFile = join(__dirname, "..", "test-results", "e2e-state.json");
    const { application } = JSON.parse(
      (await import("node:fs")).readFileSync(stateFile, "utf-8"),
    ) as { application: { inviteUrl: string } };

    const questions = await captureQuestions(page, application.inviteUrl);
    console.log(`捕获题目 ${questions.length} 道`);
    // 候选人只需 Q1+Q2 即可快速进入；Q3-Q8 在须知和前两题期间动态补齐。
    await expect
      .poll(async () => questions.length, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => questions.length, { timeout: 180_000 })
      .toBe(8);

    const bannedPatterns: Array<[string, RegExp]> = [
      ["以离职/求职状态为前提", /离职|空窗期|正在找工作|待业/],
      ["占位岗位名", /数君岗位|待自动分岗|岗位确认中/],
    ];
    for (const question of questions) {
      for (const [label, pattern] of bannedPatterns) {
        expect(
          question,
          `题目不应${label}: ${question.slice(0, 60)}`,
        ).not.toMatch(pattern);
      }
    }
    expect(questions[0]).toContain("自我介绍");
    expect(new Set(questions).size).toBe(8);
  });
});

/** 打开邀请页并拦截会话页自己的 getByToken 响应,取回全部题目文本。 */
async function captureQuestions(page: Page, inviteUrl: string): Promise<string[]> {
  const token = inviteUrl.split("/").pop() || "";
  const questions: string[] = [];
  const handler = async (response: unknown) => {
    const res = response as { url: () => string; json: () => Promise<unknown> };
    if (!res.url().includes("candidate.getByToken")) return;
    try {
      const body = (await res.json()) as unknown;
      const envelopes = Array.isArray(body) ? body : [body];
      for (const envelope of envelopes) {
        const data = dig(envelope, [
          "result", "data", "json", "interview", "questions",
        ]);
        if (Array.isArray(data)) {
          const texts = data
            .map((item) => String(dig(item, ["text"]) ?? ""))
            .filter(Boolean);
          if (texts.length > questions.length) questions.splice(0, questions.length, ...texts);
        }
      }
    } catch {
      // 忽略无关响应体
    }
  };
  page.on("response", handler);
  await page.goto(inviteUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.body.innerText.includes("面试须知") || document.body.innerText.includes("测试须知"),
    undefined,
    { timeout: 60_000 },
  );
  // 监听保持挂载:邀请页每秒重取 getByToken,题目全量到达由用例侧轮询等待
  const shotDir = join(__dirname, "..", "screenshots");
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, "10-questions-capture.png"), fullPage: true });
  if (!questions.length) {
    throw new Error(`未能从 getByToken 响应捕获题目(token=${token.slice(0, 6)}…)`);
  }
  return questions;
}

function dig(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
