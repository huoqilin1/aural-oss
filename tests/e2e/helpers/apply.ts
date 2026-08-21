import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
}

export function statePath(): string {
  return join(__dirname, "..", "test-results", "e2e-state.json");
}

export function loadState(): ApplicationHandle | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf-8")) as StateFile;
    // 30 分钟内的申请可以复用(题目已生成、会话未开始或进行中均可续用)
    if (Date.now() - new Date(raw.createdAt).getTime() > 30 * 60_000) return null;
    return raw.application;
  } catch {
    return null;
  }
}

export function saveState(application: ApplicationHandle): void {
  const dir = join(__dirname, "..", "test-results");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    statePath(),
    JSON.stringify({ application, createdAt: new Date().toISOString() }, null, 2),
  );
}

interface ResumeRow {
  file?: string;
  name_sanitized?: string;
  text_len?: number;
  text?: string;
}

function loadResume(index: number): ResumeRow {
  const rows = JSON.parse(readFileSync(RESUME_LIBRARY, "utf-8")) as ResumeRow[];
  const row = rows[index];
  if (!row?.text) throw new Error(`简历库索引 ${index} 无文本`);
  return row;
}

async function buildResumeDocx(index: number): Promise<Blob> {
  const row = loadResume(index);
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
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

async function applyWithResume(index: number): Promise<{
  candidateId: number;
  applicationToken: string;
}> {
  const resumeBlob = await buildResumeDocx(index);
  const form = new FormData();
  form.append("position", "");
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
  const { candidateId, applicationToken } = await applyWithResume(index);
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
        positionName,
        readyElapsedMs: Date.now() - started,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
}

/** 用一个新申请(或复用 30 分钟内的旧申请)驱动面试流程用例。 */
export async function ensureApplication(index: number): Promise<ApplicationHandle> {
  const cached = loadState();
  if (cached) return cached;
  const fresh = await applyAndWaitForInvite(index);
  saveState(fresh);
  return fresh;
}
