const { webkit, devices } = require('playwright');
(async () => {
  for (const headless of [true, false]) {
    const browser = await webkit.launch({ headless });
    try {
      const context = await browser.newContext({ userAgent: devices['iPhone 13'].userAgent, isMobile: true, hasTouch: true });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local capability probe</title>' }));
      const page = await context.newPage();
      await page.goto('https://webkit-capability.invalid');
      const capabilities = await page.evaluate(() => ({ secure: isSecureContext, recorder: typeof MediaRecorder,
        stream: typeof MediaStream, track: typeof MediaStreamTrack, audio: typeof AudioContext,
        canvasCapture: typeof HTMLCanvasElement.prototype.captureStream,
        userMedia: typeof navigator.mediaDevices?.getUserMedia }));
      const mediaSources = await page.evaluate(async () => {
        const result = {};
        let audio;
        try {
          audio = new AudioContext();
          const destination = audio.createMediaStreamDestination();
          result.audioTracks = destination.stream.getAudioTracks().length;
          destination.stream.getTracks().forEach(track => track.stop());
        } catch (error) { result.audioError = error.name + ': ' + error.message; }
        finally { if (audio) await audio.close(); }
        try {
          const canvas = document.createElement('canvas');
          const stream = canvas.captureStream(1);
          result.videoTracks = stream.getVideoTracks().length;
          stream.getTracks().forEach(track => track.stop());
        } catch (error) { result.videoError = error.name + ': ' + error.message; }
        return result;
      });
      console.log(JSON.stringify({ headless, capabilities, mediaSources }));
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
