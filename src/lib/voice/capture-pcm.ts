/** Stateful sample-rate conversion with fixed 256 ms microphone frames.
 * Uses weighted sample averaging, retaining partial intervals across callbacks.
 * The AudioContext runs at the native device rate; the relay still receives
 * 4096 mono samples at 16 kHz, preserving RMS/barge-in frame timing.
 */
export class MicrophonePcmFramer {
  private readonly ratio: number;
  private weight = 0;
  private sum = 0;
  private frame = new Float32Array(4096);
  private length = 0;

  constructor(sourceRate: number) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new Error("Invalid microphone sample rate");
    this.ratio = sourceRate / 16000;
  }

  push(input: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    for (let index = 0; index < input.length; index++) {
      const value = input[index];
      let remaining = 1;
      while (remaining > 1e-10) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += value * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          this.frame[this.length++] = this.sum / this.ratio;
          this.weight = 0;
          this.sum = 0;
          if (this.length === this.frame.length) {
            frames.push(this.frame);
            this.frame = new Float32Array(4096);
            this.length = 0;
          }
        }
      }
    }
    return frames;
  }
}
