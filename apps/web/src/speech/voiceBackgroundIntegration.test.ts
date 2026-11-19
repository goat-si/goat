import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { ComposerVoiceController } from "../components/chat/useComposerVoiceController";
import { captureBackgroundVoiceDraft } from "./backgroundVoiceDraft";
import { VoiceSessionRegistry } from "./voiceSession";

it("keeps a thread recording across foreground switches and never writes into a replacement draft", async () => {
  let original: string | null = "hello";
  const other = "other draft";
  let changed = () => {};
  const writes: string[] = [];
  const binding = captureBackgroundVoiceDraft({
    ownerKey: "thread-a",
    selection: { start: 5, end: 5 },
    read: () => original,
    exists: () => true,
    write: (text) => writes.push(text),
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
  });
  const releaseAudio = vi.fn(async () => ({
    audioBase64: "a",
    mimeType: "audio/wav" as const,
    sampleRateHz: 24_000 as const,
    durationMs: 1,
  }));
  const cancelAudio = vi.fn(async () => {});
  const controller = new ComposerVoiceController(
    {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread-a"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      ownerKey: "thread-a",
      cwd: null,
      locale: "en-US",
      enabled: true,
      route: { kind: "environment", environmentId: EnvironmentId.make("env") },
    },
    {
      startRecording: async () => {},
      stopRecording: releaseAudio,
      cancelRecording: cancelAudio,
      readDraft: binding.readDraft,
      commitDraft: binding.commitDraft,
      prewarm: async () => {},
      transcribe: async () => ({ text: "world" }),
    },
  );
  const registry = new VoiceSessionRegistry();
  await registry.start({
    ownerKey: "thread-a",
    persistent: true,
    controller,
    dispose: binding.dispose,
  });
  registry.ownerUnmounted(controller);
  original = null;
  changed();
  original = "replacement";
  changed();
  await registry.stop();
  expect(releaseAudio).toHaveBeenCalledOnce();
  expect(writes).toEqual([]);
  expect(original).toBe("replacement");
  expect(other).toBe("other draft");
  expect(registry.getSnapshot().unattached).toEqual([{ ownerKey: "thread-a", text: "world" }]);
});

it("releases the microphone when the destination disconnects during startup", async () => {
  let finishStart: () => void = () => {};
  const starting = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const cancelAudio = vi.fn(async () => {});
  const controller = new ComposerVoiceController(
    {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread-a"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      ownerKey: "thread-a",
      cwd: null,
      locale: "en-US",
      enabled: true,
      route: { kind: "environment", environmentId: EnvironmentId.make("env") },
    },
    {
      startRecording: () => starting,
      stopRecording: async () => null,
      cancelRecording: cancelAudio,
      readDraft: () => ({
        ownerKey: "thread-a",
        text: "",
        revision: 0,
        selection: { start: 0, end: 0 },
      }),
      commitDraft: () => {},
      prewarm: async () => {},
      transcribe: async () => ({ text: "" }),
    },
  );
  const registry = new VoiceSessionRegistry();
  const pending = registry.start({ ownerKey: "thread-a", persistent: true, controller });
  registry.disconnect();
  finishStart();
  await pending;
  expect(cancelAudio).toHaveBeenCalledOnce();
  expect(registry.getSnapshot().active).toBeNull();
  expect(controller.getSnapshot().phase).toBe("idle");
});

it("commits a background transcript into its unchanged originating draft", async () => {
  let original = "hello";
  const binding = captureBackgroundVoiceDraft({
    ownerKey: "thread-a",
    selection: { start: 5, end: 5 },
    read: () => original,
    exists: () => true,
    write: (text) => {
      original = text;
    },
    subscribe: () => () => {},
  });
  const controller = new ComposerVoiceController(
    {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread-a"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      ownerKey: "thread-a",
      cwd: null,
      locale: "en-US",
      enabled: true,
      route: { kind: "environment", environmentId: EnvironmentId.make("env") },
    },
    {
      startRecording: async () => {},
      stopRecording: async () => ({
        audioBase64: "a",
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 1,
      }),
      cancelRecording: async () => {},
      readDraft: binding.readDraft,
      commitDraft: binding.commitDraft,
      prewarm: async () => {},
      transcribe: async () => ({ text: "world" }),
    },
  );
  const registry = new VoiceSessionRegistry();
  await registry.start({
    ownerKey: "thread-a",
    persistent: true,
    controller,
    dispose: binding.dispose,
  });
  registry.ownerUnmounted(controller);
  await registry.stop();
  expect(original).toBe("hello world");
  expect(registry.getSnapshot().unattached).toEqual([]);
});
