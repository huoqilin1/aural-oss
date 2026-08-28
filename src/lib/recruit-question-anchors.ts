const SENSITIVE_ANCHOR_PATTERN = /(?:姓名|名字|电话|手机|邮箱|email|微信|wechat|身份证|住址|地址|籍贯|出生|年龄|求职意向)\s*[:：]/i;
const PHONE_OR_EMAIL_PATTERN = /(?:1[3-9]\d{9}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/|\d{1,2}岁)/i;
const INCOMPLETE_ANCHOR_PATTERN = /^(?:年以上|年经验|及以上|以上学历|相关经验)/;

function stripRecruitAnchorBullet(value: string): string {
  return value
    .replace(/^[\s\-–—•·*#>]+/, "")
    .replace(/^\d+[.、）)]\s*/, "")
    .trim();
}

export function safeRecruitAnchorLines(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\r\n。；;]+/)
    .map(stripRecruitAnchorBullet)
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
    })
    .map((line) => line.slice(0, 72));
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

export function selectRecruitAnchor(value: string, keywords: string[]): string {
  const lines = safeRecruitAnchorLines(value);
  if (!lines.length) return "";
  return [...lines].sort((left, right) => {
    const score = (line: string) => keywords.reduce(
      (total, keyword) => total + (line.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()) ? 3 : 0),
      /\d|%/.test(line) ? 1 : 0,
    );
    return score(right) - score(left);
  })[0] || "";
}

export function questionReferencesRecruitAnchor(question: string, anchor: string): boolean {
  if (!question || !anchor) return false;
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
