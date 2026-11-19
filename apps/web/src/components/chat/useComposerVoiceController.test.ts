import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type { VoiceDraftSnapshot } from "@goat/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  VoiceMicrophoneError,
  type VoiceRecordingOptions,
  type VoiceRecordingPayload,
} from "../../lib/voiceRecorder";
import {
  ComposerVoiceController,
  type ComposerVoiceDependencies,
  type ComposerVoiceTarget,
} from "./useComposerVoiceController";
import { chooseEnvironmentSpeech, readEnvironmentSpeechGrant } from "../../speech/voiceConsent";

const payload: VoiceRecordingPayload = {
  audioBase64: "fixture",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 4_000,
};

function setup(
  overrides: Partial<ComposerVoiceTarget> = {},
  dependencies: Partial<ComposerVoiceDependencies> = {},
) {
  const target: ComposerVoiceTarget = {
    environmentId: EnvironmentId.make("voice-env-a"),
    threadId: ThreadId.make("voice-thread-a"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    ownerKey: "voice-draft-a",
    cwd: "/fixture",
    locale: "en-US",
    enabled: true,
    route: { kind: "environment", environmentId: EnvironmentId.make("voice-env-a") },
    ...overrides,
  };
  let draft: VoiceDraftSnapshot = {
    ownerKey: target.ownerKey,
    text: "hello",
    selection: { start: 5, end: 5 },
    revision: 1,
  };
  let recordingOptions: VoiceRecordingOptions = {};
  const startRecording = vi.fn(async (options: VoiceRecordingOptions) => {
    recordingOptions = options;
  });
  const stopRecording = vi.fn(async () => payload);
  const cancelRecording = vi.fn(async () => undefined);
  const prewarm = vi.fn(async () => undefined);
  const transcribe = vi.fn(
    async (
      _target: ComposerVoiceTarget,
      _payload: VoiceRecordingPayload,
      _signal: AbortSignal,
    ) => ({ text: "world" }),
  );
  const commitDraft = vi.fn((text: string, selection: VoiceDraftSnapshot["selection"]) => {
    draft = { ...draft, text, selection, revision: draft.revision + 1 };
  });
  const onSubmit = vi.fn();
  const controller = new ComposerVoiceController(target, {
    startRecording,
    stopRecording,
    cancelRecording,
    prewarm,
    transcribe,
    readDraft: () => draft,
    commitDraft,
    onSubmit,
    ...dependencies,
  });
  return {
    target,
    controller,
    startRecording,
    transcribe,
    prewarm,
    commitDraft,
    onSubmit,
    stopRecording,
    cancelRecording,
    readDraft: () => draft,
    editDraft: (change: Partial<VoiceDraftSnapshot>) => {
      draft = { ...draft, ...change };
    },
    chunk: (audioBase64: string) =>
      recordingOptions.onStreamingChunk?.({ ...payload, audioBase64 }),
    pcm: (bytes: Uint8Array) => recordingOptions.onPcmFrame?.(bytes),
    pcmError: () => recordingOptions.onPcmError?.(),
    failRecording: (error: VoiceMicrophoneError) => recordingOptions.onError?.(error),
    [Symbol.dispose]: () => controller.cancel(),
  };
}

describe("composer voice controller", () => {
  it("does not request PCM streaming for batch-only recording", async () => {
    using session = setup();
    await session.controller.start();
    expect(session.startRecording.mock.calls[0]?.[0].onPcmFrame).toBeUndefined();
  });

  it("silently records in batch mode when live speech is unavailable", async () => {
    chooseEnvironmentSpeech(EnvironmentId.make("voice-env-a"));
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    const startLive = vi.fn(async () => null);
    using session = setup({ localModelGrant: grant }, { startLive });
    await session.controller.start();
    expect(startLive).toHaveBeenCalledOnce();
    expect(session.controller.getSnapshot()).toMatchObject({ phase: "recording", error: null });
    expect(await session.controller.confirm()).toBe(true);
    expect(session.readDraft().text).toBe("hello world");
    chooseEnvironmentSpeech(null);
  });
  it("keeps a live preview and commits the full batch transcript after live failure", async () => {
    chooseEnvironmentSpeech(EnvironmentId.make("voice-env-a"));
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    let preview: (text: string) => void = () => {};
    let fail: () => void = () => {};
    const startLive = vi.fn(
      async (_target, onPreview: (text: string) => void, onFailure: () => void) => {
        preview = onPreview;
        fail = onFailure;
        return { feed: async () => {}, finish: async () => null, cancel: () => {} };
      },
    );
    using session = setup({ localModelGrant: grant, liveEnabled: true }, { startLive });
    await session.controller.start();
    expect(startLive).toHaveBeenCalledOnce();
    preview("live words");
    fail();
    expect(session.controller.getSnapshot()).toMatchObject({
      phase: "recording",
      streamingPreviewText: "live words",
      error: null,
    });
    expect(await session.controller.confirm()).toBe(true);
    expect(session.transcribe).toHaveBeenCalledOnce();
    expect(session.readDraft().text).toBe("hello world");
    chooseEnvironmentSpeech(null);
  });

  it("uses the full recording when the live PCM encoder fails", async () => {
    chooseEnvironmentSpeech(EnvironmentId.make("voice-env-a"));
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    const frameReceived = deferred<void>();
    const cancel = vi.fn();
    const startLive = vi.fn(async () => ({
      feed: async () => {
        frameReceived.resolve();
      },
      finish: async () => "partial",
      cancel,
    }));
    using session = setup({ localModelGrant: grant }, { startLive });
    await session.controller.start();
    session.pcm(new Uint8Array([0, 0]));
    await frameReceived.promise;
    session.pcmError();
    expect(await session.controller.confirm()).toBe(true);
    expect(session.transcribe).toHaveBeenCalledOnce();
    expect(session.readDraft().text).toBe("hello world");
    expect(cancel).toHaveBeenCalledOnce();
    chooseEnvironmentSpeech(null);
  });

  it("commits the final live transcript only to the draft that started recording", async () => {
    chooseEnvironmentSpeech(EnvironmentId.make("voice-env-a"));
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    const frameReceived = deferred<void>();
    const startLive = vi.fn(async () => ({
      feed: async () => {
        frameReceived.resolve();
      },
      finish: async () => "live result",
      cancel: () => {},
    }));
    using session = setup({ localModelGrant: grant, liveEnabled: true }, { startLive });
    await session.controller.start();
    session.pcm(new Uint8Array([0, 0]));
    await frameReceived.promise;
    expect(session.readDraft().text).toBe("hello");
    expect(await session.controller.confirm()).toBe(true);
    expect(session.readDraft().text).toBe("hello live result");
    expect(session.transcribe).not.toHaveBeenCalled();
    chooseEnvironmentSpeech(null);
  });

  it("retains the final live transcript separately when its original draft changes", async () => {
    chooseEnvironmentSpeech(EnvironmentId.make("voice-env-a"));
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    const frameReceived = deferred<void>();
    const startLive = vi.fn(async () => ({
      feed: async () => {
        frameReceived.resolve();
      },
      finish: async () => "live result",
      cancel: () => {},
    }));
    using session = setup({ localModelGrant: grant, liveEnabled: true }, { startLive });
    await session.controller.start();
    session.pcm(new Uint8Array([0, 0]));
    await frameReceived.promise;
    session.editDraft({ text: "changed", revision: 2 });
    expect(await session.controller.confirm()).toBe(false);
    expect(session.readDraft().text).toBe("changed");
    expect(session.controller.getSnapshot().unattachedTranscript).toBe("live result");
    expect(session.transcribe).not.toHaveBeenCalled();
    chooseEnvironmentSpeech(null);
  });
  it("keeps the selected voice environment when the thread is on another machine", async () => {
    const destination = EnvironmentId.make("voice-env-a");
    chooseEnvironmentSpeech(destination);
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    using session = setup({
      environmentId: EnvironmentId.make("voice-env-b"),
      route: { kind: "environment", environmentId: destination },
      localModelGrant: grant,
    });
    await session.controller.start();
    expect(await session.controller.confirm()).toBe(true);
    expect(session.transcribe.mock.calls[0]?.[0].route).toEqual({
      kind: "environment",
      environmentId: destination,
    });
    chooseEnvironmentSpeech(null);
  });

  it("does not send preview chunks to a local speech model", async () => {
    chooseEnvironmentSpeech(EnvironmentId.make("voice-env-a"));
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    using session = setup({ localModelGrant: grant });
    await session.controller.start();
    session.chunk("preview");
    expect(session.transcribe).not.toHaveBeenCalled();
    chooseEnvironmentSpeech(null);
  });

  it("discards a transcription after the device grant is revoked", async () => {
    chooseEnvironmentSpeech(EnvironmentId.make("voice-env-a"));
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    using session = setup({ localModelGrant: grant });
    const started = deferred<void>();
    const result = deferred<{ text: string }>();
    session.transcribe.mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    await session.controller.start();
    const pending = session.controller.send();
    await started.promise;
    chooseEnvironmentSpeech(null);
    session.controller.setTarget({ ...session.target, localModelGrant: null });
    result.resolve({ text: "late" });
    expect(await pending).toBe(false);
    expect(session.commitDraft).not.toHaveBeenCalled();
  });
  it("offers System Settings only for a macOS denial and leaves the draft alone", async () => {
    using session = setup();
    session.startRecording.mockRejectedValueOnce(
      new VoiceMicrophoneError("permission-denied", "macOS is blocking GOAT.", true),
    );
    await session.controller.start();
    expect(session.controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: "macOS is blocking GOAT.",
      errorAction: "settings",
    });

    await session.controller.start();
    session.failRecording(new VoiceMicrophoneError("no-input", "No sound is reaching GOAT."));
    expect(session.controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: "No sound is reaching GOAT.",
      errorAction: "retry",
    });
    expect(session.controller.blocksSubmission()).toBe(false);
    expect(await session.controller.confirm()).toBe(false);
    expect(session.transcribe).not.toHaveBeenCalled();
    expect(session.commitDraft).not.toHaveBeenCalled();
    expect(session.readDraft().text).toBe("hello");
  });

  it("records and commits a full clip even when prewarming fails", async () => {
    using session = setup();
    session.prewarm.mockRejectedValue(new Error("warmup unavailable"));
    await session.controller.start();
    expect(session.controller.blocksSubmission()).toBe(true);
    expect(await session.controller.confirm()).toBe(true);
    expect(session.readDraft().text).toBe("hello world");
    expect(session.commitDraft).toHaveBeenCalledOnce();
    expect(session.onSubmit).not.toHaveBeenCalled();
    expect(session.controller.blocksSubmission()).toBe(false);
  });

  it("bounds previews to one in flight and the latest queued chunk, without editing the draft", async () => {
    using session = setup();
    const first = deferred<{ text: string }>();
    const latest = deferred<{ text: string }>();
    session.transcribe
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    await session.controller.start();
    session.chunk("first");
    session.chunk("dropped");
    session.chunk("latest");
    expect(session.transcribe).toHaveBeenCalledTimes(1);
    first.resolve({ text: "one" });
    await first.promise;
    expect(session.transcribe).toHaveBeenCalledTimes(2);
    expect(session.transcribe.mock.calls[1]![1].audioBase64).toBe("latest");
    latest.resolve({ text: "three" });
    await latest.promise;
    expect(session.controller.getSnapshot().streamingPreviewText).toBe("one three");
    expect(session.commitDraft).not.toHaveBeenCalled();
  });

  it("discards out-of-order previews from a retired recording without replacing the new preview", async () => {
    using session = setup();
    const old = deferred<{ text: string }>();
    const current = deferred<{ text: string }>();
    session.transcribe
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => current.promise);
    await session.controller.start();
    session.chunk("old");
    session.controller.cancel();
    await session.controller.start();
    session.chunk("new");
    current.resolve({ text: "current" });
    await current.promise;
    old.resolve({ text: "retired" });
    await old.promise;
    expect(session.controller.getSnapshot().streamingPreviewText).toBe("current");
    expect(session.commitDraft).not.toHaveBeenCalled();
  });

  it("retires previews and the queued slot before confirming the full recording", async () => {
    using session = setup();
    const preview = deferred<{ text: string }>();
    session.transcribe.mockImplementationOnce(() => preview.promise);
    await session.controller.start();
    session.chunk("preview");
    session.chunk("queued");
    const signal = session.transcribe.mock.calls[0]![2];
    expect(await session.controller.confirm()).toBe(true);
    preview.resolve({ text: "late preview" });
    await preview.promise;
    expect(signal.aborted).toBe(true);
    expect(session.transcribe).toHaveBeenCalledTimes(2);
    expect(session.readDraft().text).toBe("hello world");
    expect(session.controller.getSnapshot().streamingPreviewText).toBe("");
  });

  it("cancels during final transcription without committing or sending", async () => {
    using session = setup();
    const started = deferred<void>();
    const result = deferred<{ text: string }>();
    session.transcribe.mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    await session.controller.start();
    const send = session.controller.send();
    await started.promise;
    const signal = session.transcribe.mock.calls[0]![2];
    session.controller.cancel();
    result.resolve({ text: "late" });
    expect(await send).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(session.commitDraft).not.toHaveBeenCalled();
    expect(session.onSubmit).not.toHaveBeenCalled();
  });

  it("refuses desktop voice input before opening the microphone when this computer runs no local environment", async () => {
    using session = setup({ route: { kind: "unavailable" } });
    await session.controller.start();
    expect(session.controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: expect.stringContaining("Local environment"),
    });
    expect(session.startRecording).not.toHaveBeenCalled();
    expect(session.prewarm).not.toHaveBeenCalled();
    expect(session.transcribe).not.toHaveBeenCalled();
    expect(session.readDraft().text).toBe("hello");
  });

  it.each(["environmentId", "threadId", "providerInstanceId", "route"] as const)(
    "invalidates final transcription when %s changes",
    async (field) => {
      using session = setup();
      const started = deferred<void>();
      const result = deferred<{ text: string }>();
      session.transcribe.mockImplementation(() => {
        started.resolve();
        return result.promise;
      });
      await session.controller.start();
      const send = session.controller.send();
      await started.promise;
      const next = {
        ...session.target,
        ...(field === "environmentId" ? { environmentId: EnvironmentId.make("voice-env-b") } : {}),
        ...(field === "threadId" ? { threadId: ThreadId.make("voice-thread-b") } : {}),
        ...(field === "providerInstanceId"
          ? { providerInstanceId: ProviderInstanceId.make("codex-other") }
          : {}),
        ...(field === "route"
          ? { route: { kind: "local" as const, environmentId: EnvironmentId.make("this-mac") } }
          : {}),
      };
      session.controller.setTarget(next);
      result.resolve({ text: "late" });
      expect(await send).toBe(false);
      expect(session.commitDraft).not.toHaveBeenCalled();
      expect(session.onSubmit).not.toHaveBeenCalled();
    },
  );

  it.each(["text", "revision", "ownerKey"] as const)(
    "preserves a draft with stale %s and never sends it",
    async (field) => {
      using session = setup();
      await session.controller.start();
      session.editDraft(
        field === "revision"
          ? { revision: 2 }
          : field === "text"
            ? { text: "edited" }
            : { ownerKey: "other" },
      );
      const edited = session.readDraft();
      expect(await session.controller.send()).toBe(false);
      expect(session.readDraft()).toEqual(edited);
      expect(session.commitDraft).not.toHaveBeenCalled();
      expect(session.onSubmit).not.toHaveBeenCalled();
    },
  );

  it("never sends an empty transcript even when the captured draft contains text", async () => {
    using session = setup();
    session.transcribe.mockResolvedValue({ text: "  " });
    await session.controller.start();
    expect(await session.controller.send()).toBe(false);
    expect(session.commitDraft).not.toHaveBeenCalled();
    expect(session.onSubmit).not.toHaveBeenCalled();
  });

  it("commits a captured selection and sends precisely that committed text once", async () => {
    using session = setup();
    session.editDraft({ text: "hello replace tail", selection: { start: 6, end: 13 } });
    await session.controller.start();
    const first = session.controller.send();
    const second = session.controller.send();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(session.commitDraft).toHaveBeenCalledExactlyOnceWith("hello world tail", {
      start: 11,
      end: 11,
    });
    expect(session.onSubmit).toHaveBeenCalledExactlyOnceWith("hello world tail");
    expect(session.controller.blocksSubmission()).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps a completed transcript unattached when the originating draft changes", async () => {
  using session = setup();
  await session.controller.start();
  session.editDraft({ text: "replacement", revision: 2 });
  expect(await session.controller.confirm()).toBe(false);
  expect(session.readDraft().text).toBe("replacement");
  expect(session.controller.getSnapshot()).toMatchObject({ unattachedTranscript: "world" });
});

it("retains a transcript if writing the original draft fails", async () => {
  using session = setup();
  session.commitDraft.mockImplementationOnce(() => {
    throw new Error("draft unavailable");
  });
  await session.controller.start();
  expect(await session.controller.confirm()).toBe(false);
  expect(session.controller.getSnapshot()).toMatchObject({ unattachedTranscript: "world" });
});

it("sends from the reattached owner after committing and releasing the recording", async () => {
  using session = setup();
  const reattachedSubmit = vi.fn(() => expect(session.controller.blocksSubmission()).toBe(false));
  await session.controller.start();
  session.controller.setSubmitHandler(reattachedSubmit);
  expect(await session.controller.send()).toBe(true);
  expect(reattachedSubmit).toHaveBeenCalledExactlyOnceWith("hello world");
  expect(session.onSubmit).not.toHaveBeenCalled();
});
