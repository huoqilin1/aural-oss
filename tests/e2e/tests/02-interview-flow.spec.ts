import { test, expect, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureApplication, RESUME_LIBRARY } from "../helpers/apply";

const RESUME_INDEX = Number(process.env.RESUME_INDEX);
const SHOT_DIR = join(__dirname, "..", "screenshots");

async function evidence(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, name), fullPage: true });
  console.log(`截图: ${join(SHOT_DIR, name)}`);
}

test.describe.configure({ mode: "serial" });

test.describe("候选人面试全流程", () => {
  let inviteUrl = "";
  let positionName = "";

  test.beforeAll(async () => {
    test.skip(!RESUME_LIBRARY, "简历库不可用时跳过");
    const application = await ensureApplication(RESUME_INDEX);
    inviteUrl = application.inviteUrl;
    positionName = application.positionName;
  });

  test("先出现面试须知页,勾选后才能开始", async ({ page }) => {
    await page.goto(inviteUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 2 })).toContainText(
      `数君招聘 · ${positionName}`,
    );

    const notice = page.getByRole("heading", { name: "面试须知" });
    await expect(notice).toBeVisible();
    await expect(page.getByText("如何进入下一题")).toBeVisible();
    await expect(page.getByText("我已阅读并同意以上面试须知")).toBeVisible();

    const startButton = page.getByRole("button", { name: "开始面试" });
    await expect(startButton).toHaveCount(1);
    await expect(page.getByText(/摄像头测试|麦克风测试|语音测试|设备检测/)).toHaveCount(0);
    await expect(startButton).toBeDisabled();
    await evidence(page, "01-notice.png");

    await page.getByRole("checkbox").click();
    await expect(startButton).toBeEnabled();
    await evidence(page, "02-notice-agreed.png");
  });

  test("面试开始:标题带真实岗位,问候播报岗位,第 1 题为自我介绍", async ({ page }) => {
    await page.goto(inviteUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "开始面试" }).click();

    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toContainText(`OpRun AI 面试 · ${positionName}`, {
      timeout: 60_000,
    });
    await expect(page.getByText("第 1 / 8 题").first()).toBeVisible({ timeout: 60_000 });
    // 问候语必须说出真实岗位名
    await expect
      .poll(
        async () => page.getByText(`「${positionName}」`).count(),
        { timeout: 90_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByText("自我介绍").first()).toBeVisible();
    await evidence(page, "03-interview-started.png");
  });

  test("答完题出现醒目「下一题」按钮,点击进入第 2 题", async ({ page }) => {
    await page.goto(inviteUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "开始面试" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `OpRun AI 面试 · ${positionName}`,
      { timeout: 60_000 },
    );

    // 等小君说完问候,进入倾听状态
    await page.waitForFunction(
      () => document.body.innerText.includes("正在听"),
      undefined,
      { timeout: 120_000 },
    );

    // 聊天通道作答(与语音同走 relay text_input,确定性高)。
    // 面板打开后页面唯一 textbox 即聊天输入框(生产占位符为「输入消息…」)。
    await page.locator('[data-tour="voice-chat"] button').click();
    const chatInput = page.getByRole("textbox");
    await expect(chatInput).toBeVisible();
    await chatInput.fill(
      "你好,我做过三年后端开发,负责过订单系统的重构,把峰值处理能力提升了40%," +
        "日常用 Python 和 Go,也用 AI 工具辅助代码评审。以上是我的简要介绍。",
    );
    await chatInput.press("Enter");

    // AI 可能先作简短回应或追问(说这些时大按钮按设计隐藏),说完即恢复显示。
    // 用「容器同时含提示语和按钮」作为单一稳定条件,避免两条断言互相竞态。
    const cta = page.locator(
      '[data-tour="voice-status"]:has-text("本题答完了就点这里") button:has-text("下一题")',
    );
    await expect(cta).toBeVisible({ timeout: 120_000 });
    await evidence(page, "04-next-cta.png");

    await cta.click();
    await expect(page.getByText("第 2 / 8 题").first()).toBeVisible({ timeout: 60_000 });
    await evidence(page, "05-question-2.png");
  });

  test("八题未完成时结束请求必须被拒绝", async ({ page }) => {
    await page.goto(inviteUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "开始面试" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `OpRun AI 面试 · ${positionName}`,
      { timeout: 60_000 },
    );

    // voice-progress 容器内依次是 上一题/下一题/结束
    await page.locator('[data-tour="voice-progress"] button').nth(2).click();
    const confirmButton = page.getByRole("button", { name: "结束面试" });
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    await expect(page.getByText(/八道计分题|尚未完整|不能完成|请继续完成/).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("heading", { name: "测试已完成" })).toHaveCount(0);
    await expect(page.getByText("第 1 / 8 题").first()).toBeVisible();
    await evidence(page, "06-early-finish-rejected.png");
  });
});
