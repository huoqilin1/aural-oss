import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const baselineUrl = new URL("./typecheck-baseline.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselineUrl, "utf8"));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const tscCli = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const result = spawnSync(process.execPath, [tscCli, "--noEmit", "--pretty", "false"], {
  cwd: projectRoot,
  encoding: "utf8",
  shell: false,
});

if (result.error) {
  console.error(`TypeScript ratchet could not start: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout || ""}\n${result.stderr || ""}`;
const counts = new Map();
for (const line of output.split(/\r?\n/)) {
  const match = line.match(/^(.+)\(\d+,\d+\): error (TS\d+):/);
  if (!match) continue;
  const path = match[1].replaceAll("\\", "/").replace(/^\.\//, "");
  const key = `${path}|${match[2]}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}

if (result.status === 0) {
  console.log("TypeScript ratchet passed: no diagnostics remain.");
  process.exit(0);
}

if (counts.size === 0) {
  console.error("TypeScript ratchet failed without parseable diagnostics.");
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
  console.error("TypeScript ratchet failed; new or increased diagnostics detected:");
  for (const regression of regressions) console.error(`- ${regression}`);
  process.exit(1);
}

const actualTotal = [...counts.values()].reduce((sum, count) => sum + count, 0);
const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + count, 0);
console.log(
  `TypeScript ratchet passed: ${actualTotal}/${baselineTotal} known diagnostics; no new diagnostics.`,
);
