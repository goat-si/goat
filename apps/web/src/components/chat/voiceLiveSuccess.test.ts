import { expect, it, vi } from "vite-plus/test";
import { encodeMonoPcm16Wav, EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type { VoiceDraftSnapshot } from "@goat/client-runtime/voice-input";
import { BrowserVoiceRecorder, type VoiceRecordingPayload } from "../../lib/voiceRecorder";
import { startLiveSpeechSession, type LiveSpeechTransport } from "../../speech/liveSpeechSession";
import { ComposerVoiceController, type ComposerVoiceTarget } from "./useComposerVoiceController";

vi.mock("../../speech/voiceConsent", () => ({
  isEnvironmentSpeechGrantCurrent: () => true,
  chooseEnvironmentSpeech: () => "saved",
  useEnvironmentSpeechGrant: () => null,
}));

it("streams captured audio in order and commits the final live transcript", async () => {
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const stream = { getTracks: () => [{ stop: vi.fn() }] };
  const context = {
    sampleRate: 48_000,
    destination: {},
    resume: async () => {},
    close: async () => {},
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    createGain: () => gain,
  };
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });
  vi.stubGlobal("AudioContext", function () {
    return context;
  });
  const recorder = new BrowserVoiceRecorder();
  let onEvent: Parameters<LiveSpeechTransport["subscribe"]>[1] | undefined;
  let subscribed: () => void = () => {};
  let firstFrame: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    firstFrame = resolve;
  });
  const frames: Uint8Array[] = [];
  const transport: LiveSpeechTransport = {
    start: async () => ({ streamId: "fixture" }),
    subscribe: async (_id, event) => {
      onEvent = event;
      subscribed();
      return () => {};
    },
    feed: async (input) => {
      frames.push(Uint8Array.from(Buffer.from(input.audioBase64, "base64")));
      firstFrame();
    },
    finish: async () => {
      onEvent?.({ type: "final", text: "live result" });
    },
    cancel: async () => {},
  };
  const environmentId = EnvironmentId.make("fixture");
  const target: ComposerVoiceTarget = {
    environmentId,
    threadId: ThreadId.make("fixture"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    ownerKey: "draft",
    cwd: "/fixture",
    locale: "en",
    enabled: true,
    route: { kind: "environment", environmentId },
    localModelGrant: { id: "grant", environmentId },
  };
  let draft: VoiceDraftSnapshot = {
    ownerKey: "draft",
    text: "hello",
    selection: { start: 5, end: 5 },
    revision: 1,
  };
  const transcribe = vi.fn(
    async (
      _target: ComposerVoiceTarget,
      _payload: VoiceRecordingPayload,
      _signal: AbortSignal,
    ) => ({ text: "batch" }),
  );
  const controller = new ComposerVoiceController(target, {
    startRecording: recorder.startRecording,
    stopRecording: recorder.stopRecording,
    stopRecordingDeferred: recorder.stopRecordingDeferred,
    cancelRecording: recorder.cancelRecording,
    readDraft: () => draft,
    commitDraft: (text, selection) => {
      draft = { ...draft, text, selection, revision: 2 };
    },
    prewarm: async () => {},
    transcribe,
    startLive: async (_target, onPreview, onFailure, signal) =>
      startLiveSpeechSession({
        transport,
        locale: "en",
        canSend: () => true,
        onPreview,
        onFailure,
        signal,
      }),
  });
  try {
    await controller.start();
    await ready;
    const samples = new Float32Array(48_004).fill(0.25);
    processor.onaudioprocess?.({
      inputBuffer: { length: samples.length, numberOfChannels: 1, getChannelData: () => samples },
    } as unknown as AudioProcessingEvent);
    await sent;
    expect(await controller.confirm()).toBe(true);
    expect(draft.text).toBe("hello live result");
    expect(transcribe).not.toHaveBeenCalled();
    expect(frames.map((frame) => frame.byteLength)).toEqual([32_000, 2]);
    const expected = encodeMonoPcm16Wav([samples], 48_000, 16_000);
    if (!expected) throw new Error("invalid fixture");
    expect(Uint8Array.from(frames.flatMap((frame) => [...frame]))).toEqual(
      expected.bytes.subarray(44),
    );
  } finally {
    controller.cancel();
    await recorder.cancelRecording();
    vi.unstubAllGlobals();
  }
});
