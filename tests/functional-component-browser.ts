// Browser component tests only: no Next server, database or provider is started.
// This does not replace packaged-server or production end-to-end acceptance.
import { build } from "esbuild";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";

export async function buildFunctionalComponent(root: string) {
  const prepared = process.env.AURAL_COMPONENT_PREBUILT_DIR;
  const result = prepared ? undefined : await build({
    absWorkingDir: root, bundle: true, write: false, format: "iife", platform: "browser", conditions: ["production"],
    jsx: "automatic", outfile: "component.js", loader: { ".css": "empty", ".woff2": "dataurl", ".woff": "dataurl" },
    define: {
      "process.env": "{}", "process.browser": "true",
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_VOICE_RELAY_URL": '"ws://127.0.0.1/ws/voice"',
      "process.env.NEXT_PUBLIC_OPENAI_VOICE_RELAY_URL": '"ws://127.0.0.1/ws/openai-voice"',
    },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import { createRoot } from "react-dom/client";
      import { VoiceFunctionalHarness } from "./src/app/functional-tests/voice/voice-functional-harness";
      const params = new URLSearchParams(location.search);
      const root = createRoot(document.getElementById("root")!);
      window.__functionalUnmount = () => root.unmount();
      root.render(<VoiceFunctionalHarness language={params.get("language") || "en"} scenario={params.get("scenario") || "default"} />);
    ` },
  });
  const script = prepared ? readFileSync(resolve(prepared, "component.js"), "utf8")
    : result!.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const exportDirectory = process.env.AURAL_COMPONENT_EXPORT_DIR;
  if (exportDirectory) {
    mkdirSync(exportDirectory, { recursive: true });
    writeFileSync(resolve(exportDirectory, "component.js"), script);
  }
  const cssRoot = resolve(root, ".next/static/css");
  const css = readdirSync(cssRoot).filter(name => name.endsWith(".css")).map(name => readFileSync(resolve(cssRoot, name), "utf8")).join("\n");
  return async (context: BrowserContext) => {
    // Playwright routing does not intercept Chromium worklet module requests.
    // Execute the real asset through a blob in this virtual-origin component test.
    await context.addInitScript((source: string) => {
      if (!window.isSecureContext) return;
      const probe = new AudioContext();
      const prototype = Object.getPrototypeOf(probe.audioWorklet) as AudioWorklet;
      void probe.close();
      const addModule = prototype.addModule;
      prototype.addModule = function(url, options) {
        if (String(url).endsWith("/audio/microphone-capture.worklet.js")) {
          const asset = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          return addModule.call(this, asset, options).finally(() => URL.revokeObjectURL(asset));
        }
        return addModule.call(this, url, options);
      };
    }, readFileSync(resolve(root, "public/audio/microphone-capture.worklet.js"), "utf8"));
    context.on("page", page => page.on("pageerror", error => console.error("[component-browser]", error.message)));
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://aural-component.invalid") return route.abort();
      if (url.pathname === "/functional-tests/voice") return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/component.css"></head><body><div id="root"></div><script src="/component.js"></script></body></html>' });
      if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
      if (url.pathname === "/component.css") return route.fulfill({ contentType: "text/css", body: css });
      if (url.pathname === "/audio/microphone-capture.worklet.js") return route.fulfill({ contentType: "text/javascript", body: readFileSync(resolve(root, "public/audio/microphone-capture.worklet.js"), "utf8") });
      return route.abort();
    });
  };
}
