type TimedUtterance = {
  text?: string; definite?: boolean; start_time?: number; end_time?: number;
};

/** Full ASR responses repeat earlier segments. Scope this guard to one socket. */
export class AsrUtteranceReplayGuard {
  private readonly lastFinalByInterval = new Map<string,string>();

  isDuplicate(utterance: TimedUtterance): boolean {
    const {text, definite, start_time: start, end_time: end} = utterance;
    // Without an authoritative audio interval, text equality cannot identify
    // a repeated utterance: a person may legitimately say the same words twice.
    if (!definite || !text?.trim() || typeof start !== 'number' || typeof end !== 'number' ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return false;
    const key = JSON.stringify([start,end]);
    if (this.lastFinalByInterval.get(key) === text.trim()) return true;
    this.lastFinalByInterval.set(key,text.trim());
    return false;
  }
}
