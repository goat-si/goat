import { expect, it, vi } from "vite-plus/test";
import { startLiveSpeechSession, type LiveSpeechTransport } from "./liveSpeechSession";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("keeps the latest live preview and falls back after a feed failure", async () => {
  let event: Parameters<LiveSpeechTransport["subscribe"]>[1] | undefined;
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => ({ streamId: "fixture" })),
    subscribe: vi.fn(async (_id, onEvent) => {
      event = onEvent;
      return () => {};
    }),
    feed: vi.fn(async () => {
      throw new Error("disconnected");
    }),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const previews: string[] = [];
  const failed = deferred();
  const session = await startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => true,
    onPreview: (text) => previews.push(text),
    onFailure: () => failed.resolve(),
  });
  expect(session).not.toBeNull();
  event?.({ type: "partial", revision: 1, committed: "hello", tentative: " world" });
  session?.feed(new Uint8Array([0, 0]));
  await failed.promise;
  expect(previews).toEqual(["hello world"]);
  expect(await session?.finish()).toBeNull();
  expect(transport.finish).not.toHaveBeenCalled();
});

it("keeps the preview and falls back when the websocket disconnects", async () => {
  let event: Parameters<LiveSpeechTransport["subscribe"]>[1] | undefined;
  let disconnected: (() => void) | undefined;
  const onFailure = vi.fn();
  const previews: string[] = [];
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => ({ streamId: "fixture" })),
    subscribe: vi.fn(async (_id, onEvent, onDisconnect) => {
      event = onEvent;
      disconnected = onDisconnect;
      return () => {};
    }),
    feed: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const session = await startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => true,
    onPreview: (text) => previews.push(text),
    onFailure,
  });
  event?.({ type: "partial", revision: 1, committed: "kept", tentative: " preview" });
  disconnected?.();
  expect(onFailure).toHaveBeenCalledOnce();
  expect(previews).toEqual(["kept preview"]);
  expect(await session?.finish()).toBeNull();
});

it("does not send another frame after the device grant is revoked", async () => {
  let allowed = true;
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => ({ streamId: "fixture" })),
    subscribe: vi.fn(async () => () => {}),
    feed: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const session = await startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => allowed,
    onPreview: () => {},
    onFailure: () => {},
  });
  allowed = false;
  session?.feed(new Uint8Array([0, 0]));
  expect(transport.feed).not.toHaveBeenCalled();
  expect(await session?.finish()).toBeNull();
});

it("returns the final transcript without editing a draft during recording", async () => {
  let event: Parameters<LiveSpeechTransport["subscribe"]>[1] | undefined;
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => ({ streamId: "fixture" })),
    subscribe: vi.fn(async (_id, onEvent) => {
      event = onEvent;
      return () => {};
    }),
    feed: vi.fn(async () => {}),
    finish: vi.fn(async () => {
      event?.({ type: "final", text: "hello world" });
    }),
    cancel: vi.fn(async () => {}),
  };
  const previews: string[] = [];
  const session = await startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => true,
    onPreview: (text) => previews.push(text),
    onFailure: () => {},
  });
  event?.({ type: "partial", revision: 1, committed: "hello", tentative: " world" });
  expect(previews).toEqual(["hello world"]);
  expect(await session?.finish()).toBe("hello world");
});

it("falls back if the server ends before the recorder has stopped", async () => {
  let event: Parameters<LiveSpeechTransport["subscribe"]>[1] | undefined;
  const onFailure = vi.fn();
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => ({ streamId: "fixture" })),
    subscribe: vi.fn(async (_id, onEvent) => {
      event = onEvent;
      return () => {};
    }),
    feed: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const session = await startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => true,
    onPreview: () => {},
    onFailure,
  });
  event?.({ type: "final", text: "early" });
  expect(onFailure).toHaveBeenCalledOnce();
  expect(await session?.finish()).toBeNull();
});

it("falls back rather than dropping audio when inference cannot keep up", async () => {
  const pending = deferred();
  const failed = deferred();
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => ({ streamId: "fixture" })),
    subscribe: vi.fn(async () => () => {}),
    feed: vi.fn(() => pending.promise),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const session = await startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => true,
    onPreview: () => {},
    onFailure: () => failed.resolve(),
  });
  session?.feed(new Uint8Array([0, 0]));
  session?.feed(new Uint8Array([1, 0]));
  await failed.promise;
  expect(transport.feed).toHaveBeenCalledTimes(1);
  expect(await session?.finish()).toBeNull();
  pending.resolve();
});

it("lets the recorder wait for a frame before sending the next one", async () => {
  const first = deferred();
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => ({ streamId: "fixture" })),
    subscribe: vi.fn(async () => () => {}),
    feed: vi.fn((input) => (input.sequence === 0 ? first.promise : Promise.resolve())),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const onFailure = vi.fn();
  const session = await startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => true,
    onPreview: () => {},
    onFailure,
  });
  if (!session) throw new Error("stream unavailable");
  const pending = session.feed(new Uint8Array([0, 0]));
  expect(pending).toBeInstanceOf(Promise);
  first.resolve();
  await pending;
  await session.feed(new Uint8Array([1, 0]));
  expect(transport.feed).toHaveBeenCalledTimes(2);
  expect(onFailure).not.toHaveBeenCalled();
  session.cancel();
});

it("silently selects batch mode when starting live transcription is busy", async () => {
  const onFailure = vi.fn();
  const transport: LiveSpeechTransport = {
    start: vi.fn(async () => {
      throw new Error("busy");
    }),
    subscribe: vi.fn(async () => () => {}),
    feed: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  expect(
    await startLiveSpeechSession({
      transport,
      locale: "en",
      canSend: () => true,
      onPreview: () => {},
      onFailure,
    }),
  ).toBeNull();
  expect(onFailure).not.toHaveBeenCalled();
});

it("cancels a late-opened stream after the recording was cancelled", async () => {
  let resolveStart: (value: { streamId: string }) => void = () => {};
  const start = new Promise<{ streamId: string }>((resolve) => {
    resolveStart = resolve;
  });
  const controller = new AbortController();
  const transport: LiveSpeechTransport = {
    start: vi.fn(() => start),
    subscribe: vi.fn(async () => () => {}),
    feed: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const pending = startLiveSpeechSession({
    transport,
    locale: "en",
    canSend: () => true,
    onPreview: () => {},
    onFailure: () => {},
    signal: controller.signal,
  });
  controller.abort();
  resolveStart({ streamId: "fixture" });
  expect(await pending).toBeNull();
  expect(transport.cancel).toHaveBeenCalledWith("fixture");
  expect(transport.subscribe).not.toHaveBeenCalled();
});
