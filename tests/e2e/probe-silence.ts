// 静默询问-确认流程现场侦测:开场后不说话,验证 45s 后小君先问、确认后再切题
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
    () => document.body.innerText.includes("答完了吗"),
    undefined,
    { timeout: 90_000 },
  );
  console.log("T+" + Math.round((Date.now() - t0) / 1000) + "s ✅ 小君开口询问是否答完");
  await page.waitForFunction(
    () => document.body.innerText.includes("第 2 / 8 题"),
    undefined,
    { timeout: 60_000 },
  );
  console.log("T+" + Math.round((Date.now() - t0) / 1000) + "s ✅ 确认后进入第 2 题");
  await page.screenshot({ path: "screenshots/11-silence-ask-confirm.png", fullPage: true });
  await browser.close();
})().catch((e) => {
  console.error("PROBE_FAIL:", e.message);
  process.exit(1);
});
