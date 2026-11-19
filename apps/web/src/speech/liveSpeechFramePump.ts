import { VOICE_STREAM_MAX_CHUNK_BYTES } from "@goat/contracts";

const MAX_PENDING_AUDIO_BYTES = 15 * 32_000;
const MAX_PENDING_AUDIO_FRAMES = 15;

export interface LiveSpeechFrameSession {
  readonly feed: (bytes: Uint8Array) => Promise<void>;
  readonly finish: () => Promise<string | null>;
  readonly cancel: () => void;
}

export class LiveSpeechFramePump {
  private readonly abort = new AbortController();
  private readonly queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private session: LiveSpeechFrameSession | null = null;
  private draining: Promise<void> | null = null;
  private state: "starting" | "ready" | "failed" | "cancelled" | "finishing" = "starting";

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

  private drain() {
    if (!this.session || this.draining || this.state !== "ready") return;
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
    this.onFailure();
  }

  async finish() {
    if (this.state === "starting") {
      this.cancel();
      return null;
    }
    if (this.state !== "ready" || !this.session) return null;
    if (this.draining) {
      try {
        await this.draining;
      } catch {
        this.fail();
        return null;
      }
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
  }
}
