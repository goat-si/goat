import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type { VoiceDraftSnapshot } from "@goat/client-runtime/voice-input";
import { BrowserVoiceRecorder, type VoiceRecordingPayload } from "../../lib/voiceRecorder";
import { startLiveSpeechSession, type LiveSpeechTransport } from "../../speech/liveSpeechSession";
import { ComposerVoiceController, type ComposerVoiceTarget } from "./useComposerVoiceController";

vi.mock("../../speech/voiceConsent", () => ({
  isEnvironmentSpeechGrantCurrent: () => true,
  chooseEnvironmentSpeech: () => "saved",
  useEnvironmentSpeechGrant: () => null,
}));

it("falls back to the full 24 kHz recording when retained-sample backlog overflows", async () => {
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
  let open: (value: { streamId: string }) => void = () => {};
  let startSignal: AbortSignal | undefined;
  const opening = new Promise<{ streamId: string }>((resolve) => {
    open = resolve;
  });
  const transport: LiveSpeechTransport = {
    start: async (_locale, signal) => {
      startSignal = signal;
      return opening;
    },
    subscribe: async () => () => {},
    feed: async () => {},
    finish: async () => {},
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
    ) => ({ text: "complete" }),
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
    const samples = new Float32Array(48_000 * 16).fill(0.25);
    processor.onaudioprocess?.({
      inputBuffer: { length: samples.length, numberOfChannels: 1, getChannelData: () => samples },
    } as unknown as AudioProcessingEvent);
    expect(startSignal?.aborted).toBe(true);
    expect(await controller.confirm()).toBe(true);
    const payload = transcribe.mock.calls[0]?.[1];
    expect(payload?.sampleRateHz).toBe(24_000);
    expect(payload?.durationMs).toBe(16_000);
    const wav = Buffer.from(payload?.audioBase64 ?? "", "base64");
    expect(wav.byteLength).toBe(44 + 24_000 * 16 * 2);
    expect(wav.readInt16LE(44)).toBe(Math.round(0.25 * 32_767));
    expect(draft.text).toBe("hello complete");
  } finally {
    open({ streamId: "fixture" });
    controller.cancel();
    await recorder.cancelRecording();
    vi.unstubAllGlobals();
  }
});
