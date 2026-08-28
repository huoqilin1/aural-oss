import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Spec files in one invocation may share only the application created by that
// invocation. A rerun receives a new id and cannot silently reuse stale state.
process.env.PRODUCTION_E2E_RUN_ID ||= randomUUID();

// 跑在 WSL 无头 Chromium；假媒体流避免真实麦克风/摄像头权限弹窗,
// 也不会录到测试机周围的真人语音。自动播放放行使 TTS 语音正常走完。
export default defineConfig({
  testDir: "./tests",
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/",
  use: {
    headless: true,
    actionTimeout: 25_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
