export interface RecruitmentEvidenceDecision {
  action: "advance" | "probe" | "interaction";
  evidence_quotes: string[];
  missing_evidence: string;
  speech: string;
}

/** Validate before any model decision becomes spoken text or navigation. */
export function parseRecruitmentDecision(raw: string, answer: string): RecruitmentEvidenceDecision | null {
  try {
    const parsed = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/i," ").replace(/\s*```\s*$/,""));
    if (!parsed || !["advance","probe","interaction"].includes(parsed.action)
      || !Array.isArray(parsed.evidence_quotes) || typeof parsed.missing_evidence!=="string"
      || typeof parsed.speech!=="string" || parsed.speech.length>600) return null;
    if (parsed.evidence_quotes.some((q: unknown)=>typeof q!=="string" || !q.trim() || !answer.includes(q))) return null;
    if (parsed.action==="probe" && (!parsed.evidence_quotes.length || !parsed.missing_evidence.trim()
      || !parsed.speech.trim() || /\[(?:NEXT|PREV|INTERVIEW_COMPLETE)\]/i.test(parsed.speech))) return null;
    if (parsed.action==="advance" && parsed.missing_evidence.trim()) return null;
    return parsed as RecruitmentEvidenceDecision;
  } catch { return null; }
}

export function recruitmentDecisionSpeech(raw: string, answer: string, isZh = true): string {
  const decision = parseRecruitmentDecision(raw,answer);
  if (!decision) return isZh ? "我在听，你可以继续。" : "I'm listening; you can continue.";
  if (decision.action==="advance") return isZh ? "明白，谢谢。 [NEXT]" : "Understood, thank you. [NEXT]";
  return decision.speech.replace(/\[(?:NEXT|PREV|INTERVIEW_COMPLETE)\]/gi,"").trim();
}

export function recruitmentDecisionInstructions(isZh = true): string {
  return isZh ? `输出严格JSON，禁止在JSON外写话术：
{"action":"advance或probe或interaction","evidence_quotes":["候选人回答中逐字原文"],"missing_evidence":"当前目标尚未满足的必要信息；已满足必须为空串","speech":"自然口语"}
先阅读全文，包括句首和句尾，再摘出所有与当前目标相关的原文；不要只摘措施而漏掉前置的“为……/因为……/受限于……”依据。当前题只有一个核心目标，不能把候选人提到的每个子步骤都扩成新的核验目标。问选择依据时，主要方案有一个明确原因即满足；具体风险控制目的、现实限制本身就是原因，不能以“只是目的，不是依据”为由重问。不继续要求其验收阈值或每个子措施的依据。问验证时，具体检验办法加观察结果即可满足；复核人、报告是其他可接受形式，不是还要补齐的必填项。保密情况下，已说明周期、核对材料和验收方式即可接受，不索取保密数字或追加计算细节。问约束时，限制条件已明确即满足。目标已满足：action=advance，missing_evidence=""，不生成追问；不得因还可以了解细节而判缺失。只有当前目标无法判断：action=probe，说明缺少哪一项必要信息，用原文为依据问一个短问题，speech不加导航标记。没有说过的备选方案不引入追问。互动或更正：action=interaction，不加导航。所有引文必须逐字来自当前回答，不得编造。`
    : `Return strict JSON only: {"action":"advance|probe|interaction","evidence_quotes":["verbatim answer excerpt"],"missing_evidence":"necessary missing evidence for current goal, empty if satisfied","speech":"natural speech"}. Extract evidence before deciding. A satisfied goal means advance, never ask for details of details. Probe only one necessary missing item, with verbatim evidence and no navigation marker. Interactions and corrections do not advance.`;
}
