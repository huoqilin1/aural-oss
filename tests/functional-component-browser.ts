// Browser component tests only: no Next server, database or provider is started.
// This does not replace packaged-server or production end-to-end acceptance.
import { build } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";

export async function buildFunctionalComponent(root: string) {
  const result = await build({
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
      createRoot(document.getElementById("root")!).render(<VoiceFunctionalHarness language={params.get("language") || "en"} scenario={params.get("scenario") || "default"} />);
    ` },
  });
  const script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const cssRoot = resolve(root, ".next/static/css");
  const css = readdirSync(cssRoot).filter(name => name.endsWith(".css")).map(name => readFileSync(resolve(cssRoot, name), "utf8")).join("\n");
  return async (context: BrowserContext) => {
    context.on("page", page => page.on("pageerror", error => console.error("[component-browser]", error.message)));
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://aural-component.invalid") return route.abort();
      if (url.pathname === "/functional-tests/voice") return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/component.css"></head><body><div id="root"></div><script src="/component.js"></script></body></html>' });
      if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
      if (url.pathname === "/component.css") return route.fulfill({ contentType: "text/css", body: css });
      return route.abort();
    });
  };
}
