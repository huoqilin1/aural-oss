// 静默流程现场侦测：正式计分题没有实质回答时，只能提醒并最终标记未完成，绝不切题。
import { chromium } from "@playwright/test";
import { applyAndWaitForInvite } from "./helpers/apply";

(async () => {
  const app = await applyAndWaitForInvite(5);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();
  const t0 = Date.now();
  await page.goto(app.inviteUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[role="checkbox"]').click();
  await page.locator('button:has-text("开始面试")').click();
  await page.waitForFunction(
    () => document.body.innerText.includes("第 1 / 8 题"),
    undefined,
    { timeout: 120_000 },
  );
  console.log("T+" + Math.round((Date.now() - t0) / 1000) + "s 面试已开始,保持沉默…");
  await page.waitForFunction(
    () => document.body.innerText.includes("尚未完整完成"),
    undefined,
    { timeout: 180_000 },
  );
  const body = await page.locator("body").innerText();
  if (!body.includes("第 1 / 8 题") || body.includes("第 2 / 8 题")) {
    throw new Error("静默时错误推进了正式计分题");
  }
  console.log("T+" + Math.round((Date.now() - t0) / 1000) + "s ✅ 保持第 1 题并标记未完成");
  await page.screenshot({ path: "screenshots/11-silence-incomplete.png", fullPage: true });
  await browser.close();
})().catch((e) => {
  console.error("PROBE_FAIL:", e.message);
  process.exit(1);
});
