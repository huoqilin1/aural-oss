import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

export const HR_API_BASE = process.env.HR_API_BASE || "https://hr.yifx.vip";
export const RESUME_LIBRARY =
  process.env.RESUME_LIBRARY ||
  "/mnt/c/Users/wang/Desktop/脑图/30_resumes_extracted.json";

export interface ApplicationHandle {
  candidateId: number;
  applicationToken: string;
  inviteUrl: string;
  positionName: string;
  readyElapsedMs: number;
}

interface StateFile {
  application: ApplicationHandle;
  createdAt: string;
  runId: string;
}

export function statePath(): string {
  return join(__dirname, "..", "test-results", "e2e-state.json");
}

export function loadState(): ApplicationHandle | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf-8")) as StateFile;
    const runId = process.env.PRODUCTION_E2E_RUN_ID;
    if (!runId || raw.runId !== runId) return null;
    // 30 分钟内的申请可以复用(题目已生成、会话未开始或进行中均可续用)
    if (Date.now() - new Date(raw.createdAt).getTime() > 30 * 60_000) return null;
    return raw.application;
  } catch {
    return null;
  }
}

export function saveState(application: ApplicationHandle): void {
  const runId = process.env.PRODUCTION_E2E_RUN_ID;
  if (!runId) throw new Error("缺少本次 E2E 运行标识，拒绝保存可复用申请");
  const dir = join(__dirname, "..", "test-results");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    statePath(),
    JSON.stringify({ application, createdAt: new Date().toISOString(), runId }, null, 2),
  );
}

interface ResumeRow {
  file?: string;
  name_sanitized?: string;
  text_len?: number;
  text?: string;
}

export function assertProductionWriteApproval(): void {
  let origin = "";
  try {
    origin = new URL(HR_API_BASE).origin;
  } catch {
    // Report one fail-closed approval error below.
  }
  if (
    process.env.PRODUCTION_E2E_APPROVED !== "YES" ||
    process.env.PRODUCTION_RESUME_APPROVED !== "YES" ||
    origin !== "https://hr.yifx.vip"
  ) {
    throw new Error("缺少当前任务的生产 E2E、脱敏简历或生产域名明确授权");
  }
}

function approvalHashForIndex(index: number): string {
  const negativeIndex = Number(process.env.PRODUCTION_NEGATIVE_RESUME_INDEX);
  if (
    process.env.PRODUCTION_NEGATIVE_APPLY_APPROVED === "YES" &&
    Number.isInteger(negativeIndex) &&
    index === negativeIndex
  ) {
    return process.env.PRODUCTION_NEGATIVE_RESUME_TEXT_SHA256 || "";
  }
  if (index !== Number(process.env.RESUME_INDEX)) {
    throw new Error(`简历库索引 ${index} 未在当前任务中单独批准`);
  }
  return process.env.PRODUCTION_RESUME_TEXT_SHA256 || "";
}

export function loadApprovedResume(index: number): ResumeRow {
  assertProductionWriteApproval();
  const rows = JSON.parse(readFileSync(RESUME_LIBRARY, "utf-8")) as ResumeRow[];
  const row = rows[index];
  if (!row?.text) throw new Error(`简历库索引 ${index} 无文本`);
  const actualHash = createHash("sha256").update(row.text, "utf8").digest("hex");
  const approvedHash = approvalHashForIndex(index);
  if (!/^[0-9a-f]{64}$/i.test(approvedHash) || actualHash !== approvedHash.toLowerCase()) {
    throw new Error(`简历库索引 ${index} 的内容指纹与当前批准不一致`);
  }
  return row;
}

async function buildResumeDocx(index: number): Promise<Blob> {
  const row = loadApprovedResume(index);
  // 注意:children 必须是 TextRun 实例。传 {text} 裸对象不会报错,
  // 但生成的 docx 提不出文本,HR 侧会判 blocked_input(实测踩过)。
  const paragraphs: Paragraph[] = [];
  for (const raw of (row.text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const shortTitle = line.length <= 30 && !/[，。；：、]/.test(line);
    paragraphs.push(
      new Paragraph({
        heading: shortTitle ? HeadingLevel.HEADING_2 : undefined,
        children: [new TextRun(line)],
      }),
    );
  }
  if (paragraphs.length < 10) {
    throw new Error(`简历段落数异常(${paragraphs.length}),拒绝生成空文档`);
  }
  const doc = new Document({ sections: [{ children: paragraphs }] });
  const buffer = await Packer.toBuffer(doc);
  return new Blob([Uint8Array.from(buffer).buffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export interface OpenPosition {
  id: number;
  name: string;
}

/** 在招岗位列表(手动选岗流程:投递必须带 position_id)。 */
export async function listOpenPositions(): Promise<OpenPosition[]> {
  const response = await fetch(`${HR_API_BASE}/v1/recruit/positions`);
  if (!response.ok) throw new Error(`岗位列表失败 HTTP ${response.status}`);
  const payload = (await response.json()) as { positions?: OpenPosition[] };
  const rows = payload.positions || [];
  if (!rows.length) throw new Error("没有在招岗位");
  return rows;
}

export async function getApprovedPosition(): Promise<OpenPosition> {
  const positionId = Number(process.env.PRODUCTION_POSITION_ID);
  if (!Number.isInteger(positionId) || positionId <= 0) {
    throw new Error("缺少当前任务明确批准的 PRODUCTION_POSITION_ID");
  }
  const positions = await listOpenPositions();
  const chosen = positions.find((position) => position.id === positionId);
  if (!chosen) throw new Error(`获批岗位 ID ${positionId} 当前不在招聘列表中`);
  return chosen;
}

async function applyWithResume(index: number, position?: OpenPosition): Promise<{
  candidateId: number;
  applicationToken: string;
}> {
  const resumeBlob = await buildResumeDocx(index);
  const form = new FormData();
  form.append("position", position?.name || "");
  if (position) form.append("position_id", String(position.id));
  form.append("idempotency_key", randomUUID().replaceAll("-", ""));
  form.append("resume", resumeBlob, "resume-e2e.docx");
  const response = await fetch(`${HR_API_BASE}/v1/recruit/apply`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`投递失败 HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    success?: boolean;
    candidate_id?: number;
    application_token?: string;
    error?: string;
  };
  if (!payload.success || !payload.candidate_id || !payload.application_token) {
    throw new Error(`投递被拒: ${payload.error || JSON.stringify(payload).slice(0, 200)}`);
  }
  return { candidateId: payload.candidate_id, applicationToken: payload.application_token };
}

interface StatusPayload {
  ready?: boolean;
  invite_url?: string | null;
  position_resolution?: { status?: string; position_name?: string | null };
  interview?: { stage?: string };
}

async function fetchStatus(token: string): Promise<StatusPayload> {
  const url = `${HR_API_BASE}/v1/recruit/application/status?token=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`状态查询失败 HTTP ${response.status}`);
  return (await response.json()) as StatusPayload;
}

const PLACEHOLDER_POSITIONS = new Set(["数君岗位", "待自动分岗", "岗位确认中"]);

/**
 * 投一份简历并等到面试邀请就绪。timeoutMs 同时是 P0 提速断言的边界:
 * 分岗走快模型后全链路应在 60 秒内就绪,退化回深思考模型会超时报警。
 */
export async function applyAndWaitForInvite(
  index: number,
  timeoutMs = 60_000,
): Promise<ApplicationHandle> {
  // 手动选岗(王总 2026-08-21):投递必须带岗位,题目锚定所选岗位 JD
  const position = await getApprovedPosition();
  const { candidateId, applicationToken } = await applyWithResume(index, position);
  const started = Date.now();
  let lastStage = "";
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `面试 ${timeoutMs / 1000}s 内未就绪(最后阶段=${lastStage})——分岗/生成链路疑似退化`,
      );
    }
    const status = await fetchStatus(applicationToken);
    lastStage = status.interview?.stage || String(status.position_resolution?.status || "");
    if (status.invite_url) {
      const positionName = status.position_resolution?.position_name || "";
      if (!positionName || PLACEHOLDER_POSITIONS.has(positionName)) {
        throw new Error(`岗位名异常: "${positionName}"`);
      }
      return {
        candidateId,
        applicationToken,
        inviteUrl: status.invite_url,
        positionName: positionName || position.name,
        readyElapsedMs: Date.now() - started,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
}

/** 无岗投递:用于断言"不选岗位进不了面试"的拦截行为。 */
export async function applyWithoutPosition(index: number): Promise<{
  candidateId: number;
  applicationToken: string;
}> {
  return applyWithResume(index);
}

/**
 * 同一次 Playwright 运行中的各 spec 复用唯一申请；不同运行的 run id 不同，
 * 因此不会静默复用历史候选人或绕过冷启动。
 */
export async function ensureApplication(index: number): Promise<ApplicationHandle> {
  const cached = loadState();
  if (cached) return cached;
  const fresh = await applyAndWaitForInvite(index);
  saveState(fresh);
  return fresh;
}
