import { VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ } from "@goat/contracts";
import { VOICE_RECORDING_LIMIT_SECONDS } from "@goat/client-runtime/voice-input";
import { useEffect, useState, useSyncExternalStore } from "react";
import { encodeMonoPcm16Wav, uint8ArrayToBase64 } from "./voiceRecorderEncoding";

export const MAX_WAVEFORM_SAMPLES = 160;
const STREAMING_CHUNK_SECONDS = 4;
/** A working microphone delivers its first non-zero sample well within this; silence beyond it is a blocked or muted input. */
const FIRST_AUDIO_SIGNAL_TIMEOUT_MS = 4_000;

export type VoiceMicrophoneErrorReason =
  | "insecure-context"
  | "permission-denied"
  | "permission-restricted"
  | "microphone-unavailable"
  | "no-device"
  | "device-busy"
  | "no-input";

export class VoiceMicrophoneError extends Error {
  override readonly name = "VoiceMicrophoneError";
  constructor(
    readonly reason: VoiceMicrophoneErrorReason,
    message: string,
    /** Only a macOS denial can be undone from System Settings. */
    readonly opensSystemSettings = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const MACOS_MICROPHONE_SETTINGS =
  "System Settings › Privacy & Security › Microphone, then try again. GOAT may need to restart to notice the change.";

async function ensureDesktopMicrophoneAccess(): Promise<void> {
  const access = await window.desktopBridge?.requestMicrophoneAccess?.();
  if (access === "denied")
    throw new VoiceMicrophoneError(
      "permission-denied",
      `macOS is blocking GOAT from the microphone. Turn on GOAT in ${MACOS_MICROPHONE_SETTINGS}`,
      true,
    );
  if (access === "restricted")
    throw new VoiceMicrophoneError(
      "permission-restricted",
      "Microphone access is restricted on this Mac by device management or Screen Time, so GOAT cannot record.",
    );
  if (access === "unavailable")
    throw new VoiceMicrophoneError(
      "microphone-unavailable",
      "macOS did not report whether GOAT may use the microphone. Try again.",
    );
}

function toMicrophoneError(error: unknown): unknown {
  const name = error instanceof Error ? error.name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError")
    return new VoiceMicrophoneError(
      "permission-denied",
      window.desktopBridge
        ? `GOAT could not use the microphone. Check ${MACOS_MICROPHONE_SETTINGS}`
        : "The browser blocked the microphone. Allow microphone access for this site in the browser's site settings, then try again.",
      false,
      { cause: error },
    );
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return new VoiceMicrophoneError(
      "no-device",
      "No microphone was found. Connect one and try again.",
      false,
      { cause: error },
    );
  if (name === "NotReadableError" || name === "AbortError")
    return new VoiceMicrophoneError(
      "device-busy",
      "The microphone could not be started. Another app may be using it.",
      false,
      { cause: error },
    );
  return error;
}

export interface VoiceRecordingPayload {
  readonly audioBase64: string;
  readonly mimeType: "audio/wav";
  readonly sampleRateHz: typeof VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ;
  readonly durationMs: number;
}

export interface VoiceRecordingOptions {
  readonly onStreamingChunk?: (payload: VoiceRecordingPayload) => void;
  readonly onLimitReached?: () => void;
  /** A recording that started but then failed, such as one that never received sound. */
  readonly onError?: (error: VoiceMicrophoneError) => void;
}

interface RecorderState {
  readonly isStarting: boolean;
  readonly isRecording: boolean;
  readonly hasAudioSignal: boolean;
  readonly durationMs: number;
  readonly waveformLevels: readonly number[];
}

interface RecorderRuntime {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly processor: ScriptProcessorNode;
  readonly gain: GainNode;
  readonly chunks: Float32Array[];
  streamingChunks: Float32Array[];
  streamingSamples: number;
  sampleCount: number;
  hasAudioSignal: boolean;
  lastWaveformAt: number;
  limitReached: boolean;
  firstSignalDeadline: ReturnType<typeof setTimeout> | null;
}

const IDLE: RecorderState = {
  isStarting: false,
  isRecording: false,
  hasAudioSignal: false,
  durationMs: 0,
  waveformLevels: [],
};

class VoiceRecordingCancelledError extends Error {
  override readonly name = "VoiceRecordingCancelledError";
}

export function isVoiceRecordingCancelledError(error: unknown): boolean {
  return error instanceof VoiceRecordingCancelledError;
}

export function formatVoiceRecordingDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function encodePayload(chunks: readonly Float32Array[], sampleRate: number) {
  const encoded = encodeMonoPcm16Wav(chunks, sampleRate);
  return encoded
    ? {
        audioBase64: uint8ArrayToBase64(encoded.bytes),
        mimeType: "audio/wav" as const,
        sampleRateHz: VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
        durationMs: encoded.durationMs,
      }
    : null;
}

export class BrowserVoiceRecorder {
  private runtime: RecorderRuntime | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private releaseStarting: (() => Promise<void>) | null = null;
  private state = IDLE;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(state: RecorderState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  readonly startRecording = async (options: VoiceRecordingOptions = {}): Promise<void> => {
    if (this.state.isStarting || this.runtime)
      throw new Error("Voice recording is already running.");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new VoiceMicrophoneError(
        "insecure-context",
        "Microphone recording needs a secure connection. Open GOAT over HTTPS or on localhost in a supported browser.",
      );
    }
    const generation = ++this.generation;
    this.publish({ ...IDLE, isStarting: true });
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let gain: GainNode | null = null;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (processor) processor.onaudioprocess = null;
      source?.disconnect();
      processor?.disconnect();
      gain?.disconnect();
      await context?.close().catch(() => undefined);
    };
    const assertCurrent = () => {
      if (generation !== this.generation) throw new VoiceRecordingCancelledError();
    };
    try {
      await ensureDesktopMicrophoneAccess();
      assertCurrent();
      stream = await navigator.mediaDevices
        .getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
        .catch((error: unknown) => {
          throw toMicrophoneError(error);
        });
      assertCurrent();
      context = new AudioContext({ latencyHint: "interactive" });
      this.releaseStarting = release;
      await context.resume();
      assertCurrent();
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(2_048, 1, 1);
      gain = context.createGain();
      gain.gain.value = 0;
      const runtime: RecorderRuntime = {
        stream,
        context,
        source,
        processor,
        gain,
        chunks: [],
        streamingChunks: [],
        streamingSamples: 0,
        sampleCount: 0,
        hasAudioSignal: false,
        lastWaveformAt: -Infinity,
        limitReached: false,
        firstSignalDeadline: null,
      };
      processor.onaudioprocess = (event) => {
        if (this.runtime !== runtime || runtime.limitReached) return;
        const buffer = event.inputBuffer;
        const remaining =
          Math.round(runtime.context.sampleRate * VOICE_RECORDING_LIMIT_SECONDS) -
          runtime.sampleCount;
        const mono = new Float32Array(Math.min(buffer.length, remaining));
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let i = 0; i < mono.length; i++) {
            mono[i] = (mono[i] ?? 0) + (samples[i] ?? 0) / buffer.numberOfChannels;
          }
        }
        let sum = 0;
        for (const sample of mono) sum += sample * sample;
        // Cold microphones produce exact zeroes; retain quiet real input and all later silence.
        if (!runtime.hasAudioSignal && sum === 0) return;
        if (!runtime.hasAudioSignal && runtime.firstSignalDeadline !== null) {
          clearTimeout(runtime.firstSignalDeadline);
          runtime.firstSignalDeadline = null;
        }
        runtime.hasAudioSignal = true;
        runtime.chunks.push(mono);
        runtime.sampleCount += mono.length;
        if (options.onStreamingChunk) {
          runtime.streamingChunks.push(mono);
          runtime.streamingSamples += mono.length;
          if (runtime.streamingSamples >= runtime.context.sampleRate * STREAMING_CHUNK_SECONDS) {
            const payload = encodePayload(runtime.streamingChunks, runtime.context.sampleRate);
            runtime.streamingChunks = [];
            runtime.streamingSamples = 0;
            if (payload) options.onStreamingChunk(payload);
          }
        }
        const now = performance.now();
        if (now - runtime.lastWaveformAt >= 50) {
          runtime.lastWaveformAt = now;
          this.publish({
            ...this.state,
            hasAudioSignal: true,
            durationMs: (runtime.sampleCount / runtime.context.sampleRate) * 1_000,
            waveformLevels: [
              ...this.state.waveformLevels,
              Math.min(1, Math.sqrt(sum / Math.max(1, mono.length)) * 3.2),
            ].slice(-MAX_WAVEFORM_SAMPLES),
          });
        }
        if (runtime.sampleCount >= runtime.context.sampleRate * VOICE_RECORDING_LIMIT_SECONDS) {
          runtime.limitReached = true;
          queueMicrotask(() => {
            if (this.runtime !== runtime) return;
            if (options.onLimitReached) options.onLimitReached();
            else void this.cancelRecording();
          });
        }
      };
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      assertCurrent();
      this.releaseStarting = null;
      this.runtime = runtime;
      this.publish({ ...IDLE, isRecording: true });
      runtime.firstSignalDeadline = setTimeout(() => {
        runtime.firstSignalDeadline = null;
        if (this.runtime !== runtime || runtime.hasAudioSignal) return;
        void this.teardown().then(() =>
          options.onError?.(
            new VoiceMicrophoneError(
              "no-input",
              "No sound is reaching GOAT from the microphone. Check that the right input is selected and not muted, then try again.",
            ),
          ),
        );
      }, FIRST_AUDIO_SIGNAL_TIMEOUT_MS);
      this.timer = setInterval(() => {
        if (this.runtime !== runtime) return;
        if (this.state.durationMs === (runtime.sampleCount / runtime.context.sampleRate) * 1_000)
          return;
        this.publish({
          ...this.state,
          durationMs: (runtime.sampleCount / runtime.context.sampleRate) * 1_000,
        });
      }, 200);
    } catch (error) {
      if (this.releaseStarting === release) this.releaseStarting = null;
      await release();
      if (generation === this.generation) this.publish(IDLE);
      throw error;
    }
  };

  private async teardown() {
    ++this.generation;
    const runtime = this.runtime;
    this.runtime = null;
    const releaseStarting = this.releaseStarting;
    this.releaseStarting = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.publish(IDLE);
    if (releaseStarting) await releaseStarting();
    if (!runtime) return null;
    if (runtime.firstSignalDeadline !== null) clearTimeout(runtime.firstSignalDeadline);
    runtime.firstSignalDeadline = null;
    runtime.stream.getTracks().forEach((track) => track.stop());
    runtime.processor.onaudioprocess = null;
    runtime.source.disconnect();
    runtime.processor.disconnect();
    runtime.gain.disconnect();
    await runtime.context.close().catch(() => undefined);
    return runtime;
  }

  readonly stopRecording = async (): Promise<VoiceRecordingPayload | null> => {
    const runtime = await this.teardown();
    return runtime ? encodePayload(runtime.chunks, runtime.context.sampleRate) : null;
  };

  readonly cancelRecording = async (): Promise<void> => {
    await this.teardown();
  };
}

export function useVoiceRecorder() {
  const [recorder] = useState(() => new BrowserVoiceRecorder());
  const state = useSyncExternalStore(
    recorder.subscribe,
    recorder.getSnapshot,
    recorder.getSnapshot,
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Release the browser microphone when its owner unmounts.
  useEffect(
    () => () => {
      void recorder.cancelRecording();
    },
    [recorder],
  );
  return {
    ...state,
    startRecording: recorder.startRecording,
    stopRecording: recorder.stopRecording,
    cancelRecording: recorder.cancelRecording,
  };
}
