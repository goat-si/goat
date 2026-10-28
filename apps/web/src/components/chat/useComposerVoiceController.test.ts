import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type { VoiceDraftSnapshot } from "@goat/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  VoiceMicrophoneError,
  type VoiceRecordingOptions,
  type VoiceRecordingPayload,
} from "../../lib/voiceRecorder";
import { ComposerVoiceController, type ComposerVoiceTarget } from "./useComposerVoiceController";

const payload: VoiceRecordingPayload = {
  audioBase64: "fixture",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 4_000,
};

function setup(overrides: Partial<ComposerVoiceTarget> = {}) {
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
    failRecording: (error: VoiceMicrophoneError) => recordingOptions.onError?.(error),
    [Symbol.dispose]: () => controller.cancel(),
  };
}

describe("composer voice controller", () => {
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
