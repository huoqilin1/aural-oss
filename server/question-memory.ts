type Entry = { role: string; text: string };

/** Recruitment keeps source answers intact instead of scheduling another LLM job. */
export async function questionMemory(
  transcript: readonly Entry[],
  recruitment: boolean,
  summarize: (source: string) => Promise<string>,
): Promise<string> {
  const source = transcript
    .map(entry => `${entry.role === "user" ? "Participant" : "Interviewer"}: ${entry.text}`)
    .join("\n");
  if (!source || recruitment) return source;
  return summarize(source);
}
