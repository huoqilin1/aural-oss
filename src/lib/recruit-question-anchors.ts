const SENSITIVE_ANCHOR_PATTERN = /(?:姓名|名字|电话|手机|邮箱|email|微信|wechat|身份证|住址|地址|籍贯|出生|年龄|求职意向)\s*[:：]/i;
const PHONE_OR_EMAIL_PATTERN = /(?:1[3-9]\d{9}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/|\d{1,2}岁)/i;
const INCOMPLETE_ANCHOR_PATTERN = /^(?:年以上|年经验|及以上|以上学历|相关经验)/;
const EXPLICIT_RECRUIT_ANCHOR_PATTERN = /(?:简历中|你的简历|你在简历|你提到|你写到|你曾在|你负责的|你参与的|你过往的|你已有的|你目前的|简历尚未|材料中)/i;

/** Expand only explicit references selected by the model; never append missing facts. */
export function renderRecruitQuestionAnchorReferences(
  question: string,
  anchors: { resume: string; job: string } | undefined,
): string {
  if (!question.includes("{{")) return question;
  if (!anchors?.resume || !anchors.job || !question.includes("{{resume}}") || !question.includes("{{job}}")
    || /\{\{|\}\}/.test(question.replace(/\{\{(?:resume|job)\}\}/g, ""))) {
    throw new Error("question_anchor_invalid");
  }
  return question.replace(/\{\{(resume|job)\}\}/g, (match, key: "resume" | "job", offset: number) => {
    const before = question[offset - 1];
    const after = question[offset + match.length];
    const alreadyQuoted = (before === "“" && after === "”") || (before === '"' && after === '"')
      || (before === "「" && after === "」") || (before === "『" && after === "』");
    return alreadyQuoted ? anchors[key] : `“${anchors[key]}”`;
  });
}

function stripRecruitAnchorBullet(value: string): string {
  return value
    .replace(/^\[fact-[a-f0-9]+\|(?:project-[a-f0-9]+|unassigned)\]\s*/gm, "")
    .replace(/^[\s\-–—•·*#>]+/, "")
    .replace(/^\d+[.、）)]\s*/, "")
    .trim();
}

export function safeRecruitAnchorLines(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\r\n。；;]+/)
    .map(stripRecruitAnchorBullet)
    .map(completeRecruitAnchor)
    .filter((line) => {
      if (
        line.length < 8
        || INCOMPLETE_ANCHOR_PATTERN.test(line)
        || SENSITIVE_ANCHOR_PATTERN.test(line)
        || PHONE_OR_EMAIL_PATTERN.test(line)
      ) {
        return false;
      }
      const normalized = line.toLocaleLowerCase().replace(/\s+/g, "");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

/** Shorten only at source punctuation outside parentheses, never at character 72. */
export function completeRecruitAnchor(line: string, limit = 72): string {
  let depth = 0;
  let boundary = -1;
  for (let i = 0; i < line.length; i++) {
    if (/[（(]/.test(line[i])) depth++;
    else if (/[）)]/.test(line[i])) {
      if (!depth) return "";
      depth--;
    } else if (/[，,；;。]/.test(line[i]) && depth === 0 && i >= 8 && i <= limit) boundary = i;
  }
  if (depth === 0 && line.length <= limit) return line;
  if (boundary >= 8) return line.slice(0, boundary).trim();
  return depth === 0 && line.length <= 160 ? line : "";
}

export function recruitAnchorTerms(value: string): string[] {
  const terms = new Set<string>();
  for (const token of value.toLocaleLowerCase().match(/[a-z][a-z0-9+#._-]{2,}/g) || []) {
    terms.add(token);
  }
  for (const run of value.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let index = 0; index <= run.length - 2; index += 1) {
      const term = run.slice(index, index + 2);
      if (!/^(?:负责|相关|工作|岗位|要求|能力|进行|以及|以上)$/.test(term)) terms.add(term);
    }
  }
  return Array.from(terms).slice(0, 24);
}

export function recruitQuestionFitsRoleType(question: string, isTechnicalRole: boolean): boolean {
  if (isTechnicalRole) return true;
  return !/(?:伪代码|写\s*SQL|SQL\s*(?:语句|查询)|代码实现|接口定义|系统配置|数据库表结构)/i.test(question);
}

export function selectRecruitAnchor(value: string, keywords: string[], preferQuantified = true): string {
  const lines = safeRecruitAnchorLines(value);
  if (!lines.length) return "";
  return [...lines].sort((left, right) => {
    const score = (line: string) => keywords.reduce(
      (total, keyword) => total + (line.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()) ? 3 : 0),
      preferQuantified && /\d|%/.test(line) ? 1 : 0,
    );
    return score(right) - score(left);
  })[0] || "";
}

/** Fixed, privacy-safe reasons; never include source text or model output. */
export function recruitQuestionAnchorFailure(
  question: string,
  anchors: { resume: string; job: string } | undefined,
  isTechnicalRole: boolean,
): string | null {
  if (!anchors?.resume || !anchors.job) return "question_anchor_source_missing";
  if (!questionReferencesRecruitAnchor(question, anchors.resume)) return "question_resume_anchor_missing";
  if (!questionReferencesRecruitAnchor(question, anchors.job)) return "question_job_anchor_missing";
  if (!recruitQuestionFitsRoleType(question, isTechnicalRole)) return "question_role_mismatch";
  if (recruitAnchorScenarioDifference(anchors.resume, anchors.job)
    && !/场景.{0,10}(?:不同|差异|区别)|(?:不同|差异).{0,10}场景|迁移|尚未体现|未体现|不一定相同/.test(question)) return "question_scenario_boundary_missing";
  return null;
}

/** This detects explicit differences only; a lexical match never proves direct experience. */
export function recruitAnchorScenarioDifference(resume: string, job: string): boolean {
  const domains = [
    /电商|店铺|消费者|买家/i,
    /企业客户|企业软件|SaaS|B端/i,
    /政府|政务|工信/i,
  ];
  const left = domains.flatMap((domain, i) => domain.test(resume) ? [i] : []);
  const right = domains.flatMap((domain, i) => domain.test(job) ? [i] : []);
  return Boolean(left.length && right.length && !left.some(i => right.includes(i)));
}

export function questionReferencesRecruitAnchor(question: string, anchor: string): boolean {
  if (!question || !anchor) return false;
  // A complete citation is stronger evidence than a partial four-character
  // match. Lists such as 沟通、抗压、协作 otherwise can never pass validation.
  const compact = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(new RegExp("[^\\p{L}\\p{N}]+", "gu"), "");
  const fullAnchor = compact(anchor);
  if (fullAnchor.length >= 4 && new RegExp("\\p{L}", "u").test(fullAnchor) && compact(question).includes(fullAnchor)) return true;
  const questionNormalized = question.toLocaleLowerCase().replace(/\s+/g, "");
  const latinTokens = anchor.toLocaleLowerCase().match(/[a-z][a-z0-9+#._-]{2,}/g) || [];
  if (latinTokens.some((token) => questionNormalized.includes(token))) return true;
  const cjkRuns = anchor.match(/[\u4e00-\u9fff]{4,}/g) || [];
  return cjkRuns.some((run) => {
    for (let index = 0; index <= run.length - 4; index += 1) {
      if (questionNormalized.includes(run.slice(index, index + 4))) return true;
    }
    return false;
  });
}

export function ensureExplicitRecruitAnchorLead(question: string, anchorLead: string): string {
  const trimmedQuestion = question.trim();
  const trimmedLead = anchorLead.trim();
  if (!trimmedQuestion || !trimmedLead || EXPLICIT_RECRUIT_ANCHOR_PATTERN.test(trimmedQuestion)) {
    return trimmedQuestion;
  }
  return `${trimmedLead}${trimmedQuestion}`;
}
