const SENSITIVE_ANCHOR_PATTERN = /(?:姓名|名字|电话|手机|邮箱|email|微信|wechat|身份证|住址|地址|籍贯|出生|年龄|求职意向)\s*[:：]/i;
const PHONE_OR_EMAIL_PATTERN = /(?:1[3-9]\d{9}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/|\d{1,2}岁)/i;

export function safeRecruitAnchorLines(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\r\n。；;]+/)
    .map((line) => line.replace(/^[\s\-–—•·*#>\d.、）)]+/, "").trim())
    .filter((line) => {
      if (line.length < 8 || SENSITIVE_ANCHOR_PATTERN.test(line) || PHONE_OR_EMAIL_PATTERN.test(line)) {
        return false;
      }
      const normalized = line.toLocaleLowerCase().replace(/\s+/g, "");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .map((line) => line.slice(0, 72));
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
