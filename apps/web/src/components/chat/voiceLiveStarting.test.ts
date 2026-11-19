import { EnvironmentId, ThreadId } from "@goat/contracts";
import type { VoiceDraftSnapshot } from "@goat/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";
import { chooseEnvironmentSpeech, readEnvironmentSpeechGrant } from "../../speech/voiceConsent";
import { startLiveSpeechSession, type LiveSpeechTransport } from "../../speech/liveSpeechSession";
import type { VoiceRecordingOptions } from "../../lib/voiceRecorder";
import { ComposerVoiceController } from "./useComposerVoiceController";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["stop", "failure"])(
  "releases a late starting stream before batch fallback on %s",
  async (scenario) => {
    const env = EnvironmentId.make("fixture");
    chooseEnvironmentSpeech(env);
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    const reply = deferred();
    const cancelling = deferred();
    const release = deferred();
    let occupied = false;
    const transport: LiveSpeechTransport = {
      start: async () => {
        occupied = true;
        await reply.promise;
        return { streamId: "fixture" };
      },
      subscribe: async () => {
        throw new Error("unexpected subscription");
      },
      feed: async () => {},
      finish: async () => {},
      cancel: async () => {
        cancelling.resolve();
        await release.promise;
        occupied = false;
      },
    };
    let options: VoiceRecordingOptions = {};
    let draft: VoiceDraftSnapshot = {
      ownerKey: "draft",
      text: "hello",
      selection: { start: 5, end: 5 },
      revision: 1,
    };
    const batch = vi.fn(async () => {
      if (occupied) throw new Error("Speech is busy.");
      return { text: "complete" };
    });
    const controller = new ComposerVoiceController(
      {
        environmentId: env,
        threadId: ThreadId.make("fixture"),
        providerInstanceId: null,
        ownerKey: "draft",
        cwd: null,
        locale: "en",
        enabled: true,
        route: { kind: "environment", environmentId: env },
        localModelGrant: grant,
      },
      {
        startRecording: async (input) => {
          options = input;
        },
        stopRecording: async () => ({
          audioBase64: "full",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
        }),
        cancelRecording: async () => {},
        readDraft: () => draft,
        commitDraft: (text, selection) => {
          draft = { ...draft, text, selection, revision: 2 };
        },
        prewarm: async () => {},
        transcribe: batch,
        startLive: async (_target, onPreview, onFailure, signal) =>
          startLiveSpeechSession({
            transport,
            locale: "en",
            canSend: () => true,
            onPreview,
            onFailure,
            signal,
          }),
      },
    );
    try {
      await controller.start();
      if (scenario === "failure") options.onPcmError?.();
      const finishing = controller.confirm();
      reply.resolve();
      await cancelling.promise;
      expect(batch).not.toHaveBeenCalled();
      release.resolve();
      expect(await finishing).toBe(true);
      expect(draft.text).toBe("hello complete");
      expect(batch).toHaveBeenCalledOnce();
    } finally {
      reply.resolve();
      release.resolve();
      controller.cancel();
      chooseEnvironmentSpeech(null);
    }
  },
);
