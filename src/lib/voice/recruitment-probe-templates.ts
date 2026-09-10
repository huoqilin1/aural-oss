/** Original, versioned templates. Placeholders must bind to actual candidate words. */
export const PROBE_TEMPLATES = [
  { id:"P-T01", gap:"constraint", questions:[5], text:"你提到〔行动〕，当时最限制这个选择的条件是什么？" },
  { id:"P-T02", gap:"ownership", questions:[1], text:"你刚才说团队完成了〔成果〕，其中你本人直接负责的是哪一部分？" },
  { id:"P-T03", gap:"mechanism", questions:[2,5], text:"你提到采用了〔措施〕，具体是怎样落地到原流程中的？" },
  { id:"P-T04", gap:"rationale", questions:[2,4,5], text:"当时选择〔方案〕，最关键的依据是什么？" },
  { id:"P-T05", gap:"metric_definition", questions:[3], text:"你说的〔指标变化〕，具体用什么口径衡量？" },
  { id:"P-T06", gap:"attribution", questions:[3], text:"你如何判断〔结果变化〕与刚才那项措施有关？" },
  { id:"P-T07", gap:"validation", questions:[2,4,6], text:"你提到〔改动〕解决了问题，当时用什么证据确认？" },
  { id:"P-T08", gap:"adjustment", questions:[5], text:"你说〔做法〕最初没有奏效，之后你具体调整了什么？" },
  { id:"P-T09", gap:"timeline", questions:[7], text:"前面提到〔时间A〕，刚才提到〔时间B〕，这分别对应哪个阶段？" },
  { id:"P-T10", gap:"transfer", questions:[4,6], text:"你提到〔原场景方法〕，用于〔目标场景〕时，哪个前提需要重新验证？" },
  { id:"P-T11", gap:"confidential_validation", questions:[2,3,5], text:"不需要提供保密数字，可以说明当时用什么标准判断结果吗？" },
  { id:"P-T12", gap:"final_verification", questions:[7], text:"回到你提到的〔关键主张〕，还有一点需要确认：〔单一缺口〕？" },
] as const;

export function probeTemplateInstructions(questionIndex: number): string {
  if (questionIndex === 0) return "Q1不追问。";
  return "以下不是本轮必须提问的指令，只是确认关键证据缺失之后才可使用的措辞参考。目标已经满足时全部忽略并推进，不为套用模板寻找新缺口；占位内容必须来自真实回答：\n"
    + PROBE_TEMPLATES.filter(t => (t.questions as readonly number[]).includes(questionIndex)).map(t => `${t.gap}: ${t.text}`).join("\n");
}
