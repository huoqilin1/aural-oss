// Retain input on the audio rendering thread while the UI thread is busy.
// Transfer each complete block; never reuse a buffer after transferring it.
class MicrophoneCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.length = 0;
    this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "stop") this.active = false;
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(input.length - offset, this.block.length - this.length);
      this.block.set(input.subarray(offset, offset + count), this.length);
      this.length += count;
      offset += count;
      if (this.length === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(4096);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor("oprun-microphone-capture", MicrophoneCapture);
