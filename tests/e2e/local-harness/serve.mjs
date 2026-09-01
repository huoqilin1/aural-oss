// 静态服务器(本地验收):serve harness.html + bundle.js
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = pathname === "/" ? "/index.html" : pathname;
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(8788, "127.0.0.1", () => {
  console.log("[harness-serve] http://127.0.0.1:8788");
});
