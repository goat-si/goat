import { VOICE_STREAM_SAMPLE_RATE_HZ } from "@goat/contracts";

const FRAME_BYTES = VOICE_STREAM_SAMPLE_RATE_HZ * 2;
const MIN_INPUT_SAMPLE_RATE_HZ = 8_000;
const MAX_INPUT_SAMPLE_RATE_HZ = 384_000;

export class StreamingPcmEncoder {
  private readonly window: Float32Array;
  private readonly ratio: number;
  private frame = new Uint8Array(FRAME_BYTES);
  private view = new DataView(this.frame.buffer);
  private frameOffset = 0;
  private inputCount = 0;
  private outputCount = 0;
  private ended = false;
  private paused = false;

  constructor(
    private readonly inputRate: number,
    // Returning false stops consuming input after the current complete frame.
    private readonly onFrame: (frame: Uint8Array) => unknown,
  ) {
    if (
      !Number.isFinite(inputRate) ||
      inputRate < MIN_INPUT_SAMPLE_RATE_HZ ||
      inputRate > MAX_INPUT_SAMPLE_RATE_HZ
    )
      throw new Error("Unsupported microphone sample rate.");
    this.ratio = inputRate / VOICE_STREAM_SAMPLE_RATE_HZ;
    this.window = new Float32Array(Math.ceil(inputRate / VOICE_STREAM_SAMPLE_RATE_HZ) + 4);
  }

  push(samples: Float32Array) {
    if (this.ended) throw new Error("Audio encoder is closed.");
    this.paused = false;
    let consumed = 0;
    for (const sample of samples) {
      this.window[this.inputCount % this.window.length] = sample;
      this.inputCount++;
      consumed++;
      this.drain(false);
      if (this.paused) break;
    }
    return consumed;
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    if (this.inputCount === 0) return;
    this.drain(true);
    if (this.frameOffset > 0) this.onFrame(this.frame.slice(0, this.frameOffset));
    this.frameOffset = 0;
  }

  private drain(final: boolean) {
    const target = Math.max(1, Math.round(this.inputCount / this.ratio));
    while (this.outputCount < target) {
      const source = this.outputCount * this.ratio;
      const leftIndex = Math.floor(source);
      if (leftIndex >= this.inputCount) break;
      const fraction = source - leftIndex;
      if (!final && fraction !== 0 && leftIndex + 1 >= this.inputCount) break;
      const left = this.window[leftIndex % this.window.length] ?? 0;
      const right =
        leftIndex + 1 < this.inputCount
          ? (this.window[(leftIndex + 1) % this.window.length] ?? left)
          : left;
      const sample = fraction === 0 ? left : Math.fround(left + (right - left) * fraction);
      const clamped = Math.max(-1, Math.min(1, sample));
      const pcm = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      this.view.setInt16(this.frameOffset, pcm, true);
      this.frameOffset += 2;
      this.outputCount++;
      if (this.frameOffset === this.frame.byteLength) {
        const keepGoing = this.onFrame(this.frame);
        this.frame = new Uint8Array(FRAME_BYTES);
        this.view = new DataView(this.frame.buffer);
        this.frameOffset = 0;
        if (keepGoing === false) {
          this.paused = true;
          break;
        }
      }
    }
  }
}
