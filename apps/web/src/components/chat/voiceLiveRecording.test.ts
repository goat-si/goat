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

it("sends the complete original recording as a 24 kHz batch WAV after live disconnect", async () => {
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
  let disconnect: (() => void) | undefined;
  let subscribed: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  const transport: LiveSpeechTransport = {
    start: async () => ({ streamId: "fixture" }),
    subscribe: async (_id, _event, onDisconnect) => {
      disconnect = onDisconnect;
      subscribed();
      return () => {};
    },
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
    await ready;
    const samples = new Float32Array(48_000).fill(0.25);
    processor.onaudioprocess?.({
      inputBuffer: { length: samples.length, numberOfChannels: 1, getChannelData: () => samples },
    } as unknown as AudioProcessingEvent);
    disconnect?.();
    expect(await controller.confirm()).toBe(true);
    const payload = transcribe.mock.calls[0]?.[1];
    expect(payload?.sampleRateHz).toBe(24_000);
    const wav = Buffer.from(payload?.audioBase64 ?? "", "base64");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readInt16LE(44)).toBe(Math.round(0.25 * 32_767));
    expect(payload?.durationMs).toBe(1_000);
    expect(draft.text).toBe("hello complete");
  } finally {
    controller.cancel();
    await recorder.cancelRecording();
    vi.unstubAllGlobals();
  }
});
