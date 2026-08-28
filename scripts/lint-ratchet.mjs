import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const baseline = JSON.parse(
  readFileSync(new URL("./lint-baseline.json", import.meta.url), "utf8"),
);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const result = spawnSync(process.execPath, [nextCli, "lint"], {
  cwd: projectRoot,
  encoding: "utf8",
  shell: false,
  env: { ...process.env, CI: "1", NO_COLOR: "1" },
});

if (result.error) {
  console.error(`ESLint ratchet could not start: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout || ""}\n${result.stderr || ""}`.replace(
  /\u001b\[[0-9;]*m/g,
  "",
);
const counts = new Map();
let currentPath = "";
for (const line of output.split(/\r?\n/)) {
  const pathMatch = line.match(/^\.\/([^\s]+)$/);
  if (pathMatch) {
    currentPath = pathMatch[1].replaceAll("\\", "/");
    continue;
  }
  const diagnostic = line.match(/^\d+:\d+\s+(Error|Warning):\s+.*?\s{2}([^\s]+)$/);
  if (!currentPath || !diagnostic) continue;
  const key = `${currentPath}|${diagnostic[1]}|${diagnostic[2]}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}

if (result.status === 0) {
  console.log("ESLint ratchet passed: no diagnostics remain.");
  process.exit(0);
}

if (counts.size === 0) {
  console.error("ESLint ratchet failed without parseable diagnostics.");
  console.error(output.trim());
  process.exit(1);
}

const regressions = [];
for (const [key, count] of counts) {
  const allowed = baseline[key];
  if (allowed === undefined) regressions.push(`${key}: new diagnostic count ${count}`);
  else if (count > allowed) regressions.push(`${key}: ${count} exceeds baseline ${allowed}`);
}
if (regressions.length > 0) {
  console.error("ESLint ratchet failed; new or increased diagnostics detected:");
  for (const regression of regressions) console.error(`- ${regression}`);
  process.exit(1);
}

const actualTotal = [...counts.values()].reduce((sum, count) => sum + count, 0);
const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + count, 0);
console.log(`ESLint ratchet passed: ${actualTotal}/${baselineTotal} known diagnostics; no new diagnostics.`);
