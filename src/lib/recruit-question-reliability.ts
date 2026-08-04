export function normalizeRecruitQuestion(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]《》<>—_+\-=\/\\]+/g, "")
    .replace(/^(麻烦你|请您|请你|能否|可以|请)/, "");
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length < 2) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index < value.length - 1; index += 1) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}

export function recruitQuestionSimilarity(left: string, right: string): number {
  const a = bigrams(normalizeRecruitQuestion(left));
  const b = bigrams(normalizeRecruitQuestion(right));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  a.forEach((token) => {
    if (b.has(token)) overlap += 1;
  });
  return (2 * overlap) / (a.size + b.size);
}

export function deduplicateRecruitQuestions(
  questions: string[],
  threshold = 0.76,
): { questions: string[]; rejected: Array<{ text: string; matches: string; score: number }> } {
  const accepted: string[] = [];
  const rejected: Array<{ text: string; matches: string; score: number }> = [];
  for (const text of questions) {
    let closest = "";
    let highest = 0;
    for (const prior of accepted) {
      const score = recruitQuestionSimilarity(text, prior);
      if (score > highest) {
        highest = score;
        closest = prior;
      }
    }
    if (highest >= threshold) rejected.push({ text, matches: closest, score: highest });
    else accepted.push(text);
  }
  return { questions: accepted, rejected };
}
