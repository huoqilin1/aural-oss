/** Commands must distinguish finishing an answer from withdrawing from the interview. */
const ANSWER_DONE_SUFFIX = /(?:[，,。.!！?？\s]*(?:我(?:已经)?(?:回答|答|说|讲|做)完了|回答完毕|答完了|本题(?:回答)?结束|(?:请)?(?:进入|继续)?(?:下一题|下一个问题)|i'?m done(?: with (?:this|the) question)?|that'?s all|next question|let'?s move on to the next question))(?:了|吧|谢谢)?[。.!！?？\s]*$/i;

export function recruitmentAnswerContent(text: string): string {
  let content = text.trim();
  while (ANSWER_DONE_SUFFIX.test(content)) content = content.replace(ANSWER_DONE_SUFFIX, "").trim();
  return content;
}

export function recruitmentSpeechIntent(text: string): "answer_done" | "end_interview" | null {
  const tail = text.trim().replace(/[。.!！?？\s]+$/, "").split(/[。.!！?？]/).pop()?.trim() || "";
  if (/^(?:(?:好的?|那|我们|咱们|请|我想|我要|我希望)[，,\s]*)*(?:结束|停止|终止)(?:这次|本次|整个|整场)?面试(?:吧|了)?$/.test(tail)
    || /^(?:please\s+|let'?s\s+|i want to\s+|can we\s+)?(?:end|stop|finish)\s+(?:this |the |entire )?interview(?: now)?$/i.test(tail)
    || /^i'?m done with (?:the )?interview$/i.test(tail)) return "end_interview";
  if (/(?:我(?:已经)?(?:回答|答|说|讲|做)完了|答完了|回答完毕|本题(?:回答)?结束|下一题|下一个问题)(?:[，,\s]*(?:请)?(?:进入|继续)?(?:下一题|下一个问题))?(?:了|吧|谢谢)?$/.test(tail)
    || /^(?:i'?m done(?: with (?:this|the) question)?|that'?s all|next question|let'?s move on to the next question)$/i.test(tail)) return "answer_done";
  return null;
}

export function recruitmentQ1Transition(input: {
  recruitment: boolean; questionIndex: number; hasAnswer: boolean; controlOnly: boolean; isZh: boolean;
}): string | null {
  if (!input.recruitment || input.questionIndex !== 0 || !input.hasAnswer || input.controlOnly) return null;
  return input.isZh ? "谢谢，我们接着聊你的具体经历。 [NEXT]" : "Thank you. Let's discuss your experience. [NEXT]";
}

/** Relay gate, before farewell/terminal events. The save API remains the durable gate. */
export function hasEightScoredAnswers(indices: Iterable<number>): boolean {
  const answered = new Set(indices);
  return Array.from({ length: 8 }, (_, i) => i).every(i => answered.has(i));
}
