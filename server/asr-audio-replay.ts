/** Keep the unacknowledged turn for a transient recognizer reconnect, never another question. */
export function createAsrAudioReplayBuffer(maxBytes = 8 * 1024 * 1024) {
  let question = -1;
  let chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const reset = (index: number) => { question = index; chunks = []; bytes = 0; overflow = false; };
  return {
    append(index: number, pcm: Buffer) {
      if (question !== index) reset(index);
      if (overflow) return;
      if (bytes + pcm.length > maxBytes) { chunks = []; bytes = 0; overflow = true; return; }
      chunks.push(Buffer.from(pcm));
      bytes += pcm.length;
    },
    acknowledge(index: number) { reset(index); },
    snapshot(index: number): Buffer[] | null {
      if (question !== index) return [];
      // Never pass a truncated answer off as a successful replay.
      return overflow ? null : chunks.slice();
    },
  };
}
