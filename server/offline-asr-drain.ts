/** Do not commit a VAD segment while later microphone audio is still decoding.
 * Sequence receipts contain no audio or text and reset with each ASR turn.
 */
export class OfflineAsrDrain {
  private acknowledged = 0;
  private required = 0;
  private silenceBytes = 0;
  private heardSpeech = false;

  reset() {
    this.acknowledged = this.required = this.silenceBytes = 0;
    this.heardSpeech = false;
  }

  sent(sequence: number, bytes: number, active: boolean) {
    if (active) { this.heardSpeech = true; this.silenceBytes = 0; }
    if (!this.heardSpeech) return;
    // One second of processed silence exceeds the sidecar's 700ms VAD end.
    if (active || this.silenceBytes < 32000) {
      this.required = sequence;
      if (!active) this.silenceBytes += bytes;
    }
  }

  acknowledge(sequence: unknown) {
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0) {
      this.acknowledged = Math.max(this.acknowledged, sequence);
    }
  }

  get pending() {
    return this.heardSpeech && (this.silenceBytes < 32000 || this.acknowledged < this.required);
  }
}
