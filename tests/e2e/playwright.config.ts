import { defineConfig } from "@playwright/test";

// 跑在 WSL 无头 Chromium；假媒体流避免真实麦克风/摄像头权限弹窗,
// 也不会录到测试机周围的真人语音。自动播放放行使 TTS 语音正常走完。
export default defineConfig({
  testDir: "./tests",
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/",
  use: {
    headless: true,
    actionTimeout: 25_000,
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
