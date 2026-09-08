const generations = new WeakMap<string[], Map<number, number>>();

/** Keep lossless context immediately; model compression never gates speech/input. */
export async function speakWithBackgroundSummary(
  summaries: string[], index: number, transcript: string,
  summarize: () => Promise<string>, speak: () => Promise<void>,
): Promise<void> {
  let versions = generations.get(summaries);
  if (!versions) { versions = new Map(); generations.set(summaries, versions); }
  const version = (versions.get(index) ?? 0) + 1;
  versions.set(index, version);
  summaries[index] = transcript;
  if (transcript) {
    void Promise.resolve().then(summarize).then(summary => {
      if (versions.get(index) === version && summary.trim()) summaries[index] = summary;
    }).catch(() => { /* Keep the complete transcript when compression fails. */ });
  }
  await speak();
}
