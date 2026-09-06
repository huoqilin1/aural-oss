/** Commands must distinguish finishing an answer from withdrawing from the interview. */
const ANSWER_DONE_SUFFIX = /(?:[，,。.!！?？\s]*(?:我(?:已经)?(?:回答|答|说|讲|做)完了|回答完毕|答完了|本题(?:回答)?结束|(?:请)?(?:进入|继续)?(?:下一题|下一个问题)|i'?m done(?: with (?:this|the) question)?|that'?s all|next question|let'?s move on to the next question))(?:了|吧|谢谢)?[。.!！?？\s]*$/i;

function answerDoneMatch(text: string): RegExpMatchArray | null {
  // Quoted or negated examples are evidence, not interviewer commands.
  const match = text.match(ANSWER_DONE_SUFFIX);
  if (!match || match.index == null) return null;
  const prefix = text.slice(0, match.index);
  if (prefix.lastIndexOf("“") > prefix.lastIndexOf("”")
    || prefix.lastIndexOf("「") > prefix.lastIndexOf("」")
    || prefix.lastIndexOf("『") > prefix.lastIndexOf("』")
    || (prefix.match(/"/g)?.length || 0) % 2 === 1) return null;
  if (/(?:说|表示|提示|写|问|比如|例如|不要|不想|不能|尚未|还没|没有|not\s+say|said|says|saying|asked|don't|do\s+not)[：:\s]*$/i.test(prefix)) return null;
  if (prefix && /(?:下一题|下一个问题|next question)/i.test(match[0])
    && !/^[，,。.!！?？\s]/.test(match[0])) return null;
  return match;
}

export function recruitmentAnswerContent(text: string): string {
  let content = text.trim();
  let match: RegExpMatchArray | null;
  while ((match = answerDoneMatch(content))) content = content.slice(0, match.index).trim();
  return content;
}

export function recruitmentSpeechIntent(text: string): "answer_done" | "end_interview" | null {
  const tail = text.trim().replace(/[。.!！?？\s]+$/, "").split(/[。.!！?？]/).pop()?.trim() || "";
  if (/^(?:(?:好的?|那|我们|咱们|请|我想|我要|我希望)[，,\s]*)*(?:结束|停止|终止)(?:这次|本次|整个|整场)?面试(?:吧|了)?$/.test(tail)
    || /^(?:please\s+|let'?s\s+|i want to\s+|can we\s+)?(?:end|stop|finish)\s+(?:this |the |entire )?interview(?: now)?$/i.test(tail)
    || /^i'?m done with (?:the )?interview$/i.test(tail)) return "end_interview";
  if (answerDoneMatch(text.trim())) return "answer_done";
  if (/^(?:请)?(?:跳过(?:这道题|这题|本题)?|换下一题)[。.!！?？\s]*$/.test(text.trim())
    || /^(?:please\s+)?skip\s+(?:this|the)\s+question[.!?\s]*$/i.test(text.trim())) return "answer_done";
  return null;
}

/** Admissions of missing skills are answers, not skip requests. */
export function recruitmentControlOnly(text: string): boolean {
  return recruitmentSpeechIntent(text) !== null
    && (!recruitmentAnswerContent(text) || /^(?:请)?(?:跳过(?:这道题|这题|本题)?|换下一题)[。.!！?？\s]*$/.test(text.trim())
      || /^(?:please\s+)?skip\s+(?:this|the)\s+question[.!?\s]*$/i.test(text.trim()));
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
