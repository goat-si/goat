import { VOICE_STREAM_MAX_CHUNK_BYTES } from "@goat/contracts";
import { StreamingPcmEncoder } from "./streamingPcmEncoder";

const MAX_PENDING_AUDIO_BYTES = 15 * 32_000;
const MAX_PENDING_AUDIO_FRAMES = 15;
const MAX_PENDING_CAPTURE_SECONDS = 15;
const MAX_PENDING_CAPTURE_CHUNKS = 4_096;
const CAPTURE_SLICE_SAMPLES = 2_048;

export interface LiveSpeechFrameSession {
  readonly feed: (bytes: Uint8Array) => Promise<void>;
  readonly finish: () => Promise<string | null>;
  readonly cancel: () => void;
}

export class LiveSpeechFramePump {
  private readonly abort = new AbortController();
  private readonly queued: Uint8Array[] = [];
  private readonly capture: Array<{ readonly samples: Float32Array; offset: number }> = [];
  private queuedBytes = 0;
  private captureSamples = 0;
  private captureRate: number | null = null;
  private encoder: StreamingPcmEncoder | null = null;
  private encoderFinished = false;
  private session: LiveSpeechFrameSession | null = null;
  private draining: Promise<void> | null = null;
  private state: "starting" | "ready" | "failed" | "cancelled" | "finishing" = "starting";

  get active() {
    return this.state === "starting" || this.state === "ready";
  }

  stopStreaming() {
    this.fail();
  }

  constructor(
    start: (signal: AbortSignal, onFailure: () => void) => Promise<LiveSpeechFrameSession | null>,
    private readonly onFailure: () => void,
  ) {
    void start(this.abort.signal, () => this.fail()).then(
      (session) => {
        if (this.state !== "starting") {
          session?.cancel();
          return;
        }
        if (!session) return this.fail();
        this.session = session;
        this.state = "ready";
        this.drain();
        this.drainCapture();
      },
      () => this.fail(),
    );
  }

  push(frame: Uint8Array) {
    if (this.state !== "starting" && this.state !== "ready") return;
    if (
      frame.byteLength === 0 ||
      frame.byteLength % 2 !== 0 ||
      frame.byteLength > VOICE_STREAM_MAX_CHUNK_BYTES ||
      this.queued.length >= MAX_PENDING_AUDIO_FRAMES ||
      this.queuedBytes + frame.byteLength > MAX_PENDING_AUDIO_BYTES
    )
      return this.fail();
    this.queued.push(frame);
    this.queuedBytes += frame.byteLength;
    this.drain();
  }

  pushSamples(samples: Float32Array, sampleRate: number) {
    if (this.state !== "starting" && this.state !== "ready") return;
    if (samples.length === 0) return;
    if (
      (this.captureRate !== null && this.captureRate !== sampleRate) ||
      this.capture.length >= MAX_PENDING_CAPTURE_CHUNKS ||
      this.captureSamples + samples.length > sampleRate * MAX_PENDING_CAPTURE_SECONDS
    )
      return this.fail();
    if (!this.encoder) {
      try {
        this.encoder = new StreamingPcmEncoder(sampleRate, (frame) => {
          this.push(frame);
          return false;
        });
        this.captureRate = sampleRate;
      } catch {
        return this.fail();
      }
    }
    this.capture.push({ samples, offset: 0 });
    this.captureSamples += samples.length;
    this.drainCapture();
  }

  private drainCapture() {
    if (!this.session || !this.encoder || this.draining || this.state !== "ready") return;
    while (this.capture.length > 0 && !this.draining && this.state === "ready") {
      const next = this.capture[0];
      if (!next) break;
      const end = Math.min(next.offset + CAPTURE_SLICE_SAMPLES, next.samples.length);
      let consumed: number;
      try {
        consumed = this.encoder.push(next.samples.subarray(next.offset, end));
      } catch {
        this.fail();
        return;
      }
      if (this.state !== "ready") return;
      this.captureSamples -= consumed;
      next.offset += consumed;
      if (next.offset === next.samples.length) this.capture.shift();
    }
  }

  private drain() {
    if (!this.session || this.draining || this.state !== "ready" || this.queued.length === 0)
      return;
    const session = this.session;
    const pending = (async () => {
      while (this.state === "ready" && this.queued.length > 0) {
        const frame = this.queued.shift();
        if (!frame) break;
        await session.feed(frame);
        if (this.state !== "ready") return;
        this.queuedBytes -= frame.byteLength;
      }
    })();
    this.draining = pending;
    void pending.then(
      () => {
        if (this.draining === pending) this.draining = null;
        this.drain();
        this.drainCapture();
      },
      () => this.fail(),
    );
  }

  private fail() {
    if (this.state === "failed" || this.state === "cancelled") return;
    this.state = "failed";
    this.abort.abort();
    this.session?.cancel();
    this.queued.length = 0;
    this.queuedBytes = 0;
    this.capture.length = 0;
    this.captureSamples = 0;
    this.encoder = null;
    this.onFailure();
  }

  async finish() {
    if (this.state === "starting") {
      this.cancel();
      return null;
    }
    if (this.state === "failed" && this.session) {
      try {
        await this.session.finish();
      } catch {
        return null;
      }
      return null;
    }
    if (this.state !== "ready" || !this.session) return null;
    while (this.state === "ready") {
      this.drainCapture();
      const pending = this.draining;
      if (pending) {
        try {
          await pending;
        } catch {
          this.fail();
          return null;
        }
        if (this.draining === pending) this.draining = null;
        continue;
      }
      if (this.capture.length > 0) {
        this.fail();
        return null;
      }
      if (this.encoder && !this.encoderFinished) {
        this.encoderFinished = true;
        try {
          this.encoder.finish();
        } catch {
          this.fail();
          return null;
        }
        continue;
      }
      break;
    }
    if (this.state !== "ready") return null;
    if (this.queued.length > 0) {
      this.fail();
      return null;
    }
    this.state = "finishing";
    try {
      return await this.session.finish();
    } catch {
      this.fail();
      return null;
    }
  }

  cancel() {
    if (this.state === "cancelled" || this.state === "failed") return;
    this.state = "cancelled";
    this.abort.abort();
    this.session?.cancel();
    this.queued.length = 0;
    this.queuedBytes = 0;
    this.capture.length = 0;
    this.captureSamples = 0;
    this.encoder = null;
  }
}
