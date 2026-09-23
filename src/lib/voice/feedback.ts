import { z } from "zod";

/**
 * 完成页匿名反馈:只收集评分、标签与可选备注。
 * 调研目的:改进面试体验与 HR 看板统计,不需要身份信息。
 */
export const FEEDBACK_TAGS = [
  "面试流程顺畅",
  "题目贴近岗位",
  "AI 提问自然",
  "等待反馈太久",
  "遇到技术问题",
] as const;

export const feedbackSchema = z.object({
  sessionId: z.string().min(1),
  inviteToken: z.string().min(1).optional(),
  rating: z.number().int().min(1).max(5),
  tags: z
    .array(z.string().min(1).max(30))
    .max(FEEDBACK_TAGS.length)
    .default([]),
  note: z.string().max(500).optional(),
});

export type FeedbackPayload = z.infer<typeof feedbackSchema>;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 中国大陆手机号或带区号座机(11 位 / 3-4 位区号 + 7-8 位号码)
const PHONE_RE = /(?<![0-9])(?:1[3-9]\d{9}|\d{3,4}-\d{7,8})(?![0-9])/g;

/**
 * 反馈备注入库前抹掉邮箱与电话,保证匿名(反馈只用于统计,不用于联系)。
 */
export function maskNotePii(note: string): string {
  return note.replace(EMAIL_RE, "***").replace(PHONE_RE, "***");
}
