const required = [
  ["PRODUCTION_E2E_APPROVED", "YES"],
  ["PRODUCTION_RESUME_APPROVED", "YES"],
];

const missing = required
  .filter(([name, expected]) => process.env[name] !== expected)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(
    `Production E2E blocked: explicit current-task approval is required (${missing.join(
      ", ",
    )}).`,
  );
  process.exit(2);
}

const hrBase = process.env.HR_API_BASE;
let hrOrigin = "";
try {
  hrOrigin = new URL(hrBase || "").origin;
} catch {
  // The explicit error below is clearer than URL's parser error.
}
if (hrOrigin !== "https://hr.yifx.vip") {
  console.error(
    "Production E2E blocked: HR_API_BASE must explicitly equal https://hr.yifx.vip.",
  );
  process.exit(2);
}

const resumeIndex = Number(process.env.RESUME_INDEX);
const positionId = Number(process.env.PRODUCTION_POSITION_ID);
const resumeHash = process.env.PRODUCTION_RESUME_TEXT_SHA256 || "";
// 官网 UI 真实简历投递(自动识别岗位)有独立的授权组合:
// RESUME_FILE + 文件字节指纹 + PRODUCTION_AUTO_MATCH_APPROVED,
// 此时岗位 ID 与简历库哈希由该组合替代(仍失败关闭)。
const careersAutoMatch =
  process.env.APPLY_VIA === "careers_ui"
  && process.env.PRODUCTION_AUTO_MATCH_APPROVED === "YES"
  && Boolean(process.env.RESUME_FILE)
  && process.env.PRODUCTION_RESUME_FILE_APPROVED === "YES"
  && /^[0-9a-f]{64}$/i.test(process.env.PRODUCTION_RESUME_FILE_SHA256 || "");
if (!Number.isInteger(resumeIndex) || resumeIndex < 0) {
  console.error("Production E2E blocked: RESUME_INDEX must be an explicitly approved index.");
  process.exit(2);
}
if (!careersAutoMatch && (!Number.isInteger(positionId) || positionId <= 0)) {
  console.error("Production E2E blocked: PRODUCTION_POSITION_ID must be explicitly approved.");
  process.exit(2);
}
if (!careersAutoMatch && !/^[0-9a-f]{64}$/i.test(resumeHash)) {
  console.error(
    "Production E2E blocked: PRODUCTION_RESUME_TEXT_SHA256 must identify the approved deidentified resume content.",
  );
  process.exit(2);
}

if (process.env.PRODUCTION_NEGATIVE_APPLY_APPROVED === "YES") {
  const negativeIndex = Number(process.env.PRODUCTION_NEGATIVE_RESUME_INDEX);
  const negativeHash = process.env.PRODUCTION_NEGATIVE_RESUME_TEXT_SHA256 || "";
  if (!Number.isInteger(negativeIndex) || negativeIndex < 0 || !/^[0-9a-f]{64}$/i.test(negativeHash)) {
    console.error(
      "Production E2E blocked: an approved negative apply requires its own resume index and SHA-256.",
    );
    process.exit(2);
  }
}
