/** Preserve a revised ASR final as evidence on its original question. */
export function answerRevisionMessage(
  event: {text?: unknown; questionId?: unknown; questionIndex?: unknown; messageId?: unknown; timestamp?: unknown},
  questionIdAt: (index: number) => string | undefined,
): {role: "user"; content: string; questionId: string; messageId?: string; timestamp?: string} | null {
  if (typeof event.questionIndex !== "number" || !Number.isInteger(event.questionIndex) || event.questionIndex < 0) return null;
  const questionId = questionIdAt(event.questionIndex);
  if (!questionId || typeof event.questionId !== "string" || event.questionId !== questionId) return null;
  if (typeof event.text !== "string" || !event.text.trim()) return null;
  // Append instead of overwriting an earlier batch that may already be saved.
  return {role: "user", questionId, content: `【语音识别修订，以本条为准】${event.text.trim()}`,
    ...(typeof event.messageId === 'string' ? {messageId:event.messageId} : {}),
    ...(typeof event.timestamp === 'string' ? {timestamp:event.timestamp} : {})};
}
