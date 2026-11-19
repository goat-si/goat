import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type { VoiceDraftSnapshot } from "@goat/client-runtime/voice-input";
import { chooseEnvironmentSpeech, readEnvironmentSpeechGrant } from "../../speech/voiceConsent";
import { startLiveSpeechSession, type LiveSpeechTransport } from "../../speech/liveSpeechSession";
import type { VoiceRecordingOptions, VoiceRecordingPayload } from "../../lib/voiceRecorder";
import { ComposerVoiceController, type ComposerVoiceTarget } from "./useComposerVoiceController";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it.each(["connection loss", "server shutdown", "audio backlog overflow"])(
  "uses the full batch recording after %s",
  async (scenario) => {
    const environmentId = EnvironmentId.make("fixture");
    chooseEnvironmentSpeech(environmentId);
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    let onEvent: Parameters<LiveSpeechTransport["subscribe"]>[1] | undefined;
    let disconnect: (() => void) | undefined;
    const subscribed = deferred();
    const cancel = vi.fn(async () => {});
    const transport: LiveSpeechTransport = {
      start: async () => ({ streamId: "fixture" }),
      subscribe: async (_id, event, onDisconnect) => {
        onEvent = event;
        disconnect = onDisconnect;
        subscribed.resolve();
        return () => {};
      },
      feed: async () =>
        scenario === "audio backlog overflow" ? new Promise<void>(() => {}) : undefined,
      finish: async () => {},
      cancel,
    };
    const target: ComposerVoiceTarget = {
      environmentId,
      threadId: ThreadId.make("fixture"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      ownerKey: "draft",
      cwd: "/fixture",
      locale: "en",
      enabled: true,
      route: { kind: "environment", environmentId },
      localModelGrant: grant,
    };
    let draft: VoiceDraftSnapshot = {
      ownerKey: "draft",
      text: "hello",
      selection: { start: 5, end: 5 },
      revision: 1,
    };
    let options: VoiceRecordingOptions = {};
    const full: VoiceRecordingPayload = {
      audioBase64: "FULL_AUDIO_FIXTURE",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 2_000,
    };
    const transcribe = vi.fn(
      async (
        _target: ComposerVoiceTarget,
        _payload: VoiceRecordingPayload,
        _signal: AbortSignal,
      ) => ({ text: "complete result" }),
    );
    const controller = new ComposerVoiceController(target, {
      startRecording: async (input) => {
        options = input;
      },
      stopRecording: async () => full,
      cancelRecording: async () => {},
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
      await subscribed.promise;
      onEvent?.({ type: "partial", revision: 1, committed: "live", tentative: " preview" });
      if (scenario === "audio backlog overflow") {
        for (let index = 0; index < 16; index++) options.onPcmFrame?.(new Uint8Array(32_000));
      } else {
        options.onPcmFrame?.(new Uint8Array([0, 0]));
        disconnect?.();
      }
      expect(cancel).toHaveBeenCalledOnce();
      expect(controller.getSnapshot()).toMatchObject({
        phase: "recording",
        streamingPreviewText: "live preview",
        error: null,
      });
      expect(await controller.confirm()).toBe(true);
      expect(transcribe.mock.calls[0]?.[1]).toEqual(full);
      expect(draft.text).toBe("hello complete result");
    } finally {
      controller.cancel();
      chooseEnvironmentSpeech(null);
    }
  },
);
