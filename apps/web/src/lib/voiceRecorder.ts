import { VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ } from "@goat/contracts";
import { VOICE_RECORDING_LIMIT_SECONDS } from "@goat/client-runtime/voice-input";
import { useEffect, useState, useSyncExternalStore } from "react";
import { encodeMonoPcm16Wav, uint8ArrayToBase64 } from "./voiceRecorderEncoding";

export const MAX_WAVEFORM_SAMPLES = 160;
const STREAMING_CHUNK_SECONDS = 4;

export interface VoiceRecordingPayload {
  readonly audioBase64: string;
  readonly mimeType: "audio/wav";
  readonly sampleRateHz: typeof VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ;
  readonly durationMs: number;
}

export interface VoiceRecordingOptions {
  readonly onStreamingChunk?: (payload: VoiceRecordingPayload) => void;
  readonly onLimitReached?: () => void;
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
      throw new Error("Microphone recording requires a supported browser and a secure connection.");
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
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
