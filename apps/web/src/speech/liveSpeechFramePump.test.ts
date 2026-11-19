import { expect, it, vi } from "vite-plus/test";
import { LiveSpeechFramePump } from "./liveSpeechFramePump";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("sends frames captured during startup in order and waits for each acknowledgement", async () => {
  const opened = deferred<{
    feed: (bytes: Uint8Array) => Promise<void>;
    finish: () => Promise<string | null>;
    cancel: () => void;
  } | null>();
  const first = deferred<void>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const feed = vi.fn((bytes: Uint8Array) => {
    if (bytes[0] === 1) {
      firstStarted.resolve();
      return first.promise;
    }
    secondStarted.resolve();
    return Promise.resolve();
  });
  const session = { feed, finish: vi.fn(async () => "complete"), cancel: vi.fn() };
  const failed = vi.fn();
  const pump = new LiveSpeechFramePump(() => opened.promise, failed);
  pump.push(new Uint8Array([1, 0]));
  pump.push(new Uint8Array([2, 0]));
  opened.resolve(session);
  await firstStarted.promise;
  expect(feed).toHaveBeenCalledTimes(1);
  first.resolve();
  await secondStarted.promise;
  expect(feed.mock.calls.map(([bytes]) => bytes[0])).toEqual([1, 2]);
  expect(await pump.finish()).toBe("complete");
  expect(failed).not.toHaveBeenCalled();
});

it("abandons live streaming when its bounded backlog fills", async () => {
  const opened = deferred<null>();
  const failed = vi.fn();
  const pump = new LiveSpeechFramePump(() => opened.promise, failed);
  for (let index = 0; index < 16; index++) pump.push(new Uint8Array(32_000));
  expect(failed).toHaveBeenCalledOnce();
  expect(await pump.finish()).toBeNull();
  opened.resolve(null);
});

it("uses batch fallback when stopped during model startup and cancels a late stream", async () => {
  const opened = deferred<{
    feed: (bytes: Uint8Array) => Promise<void>;
    finish: () => Promise<string | null>;
    cancel: () => void;
  } | null>();
  let signal: AbortSignal | undefined;
  const pump = new LiveSpeechFramePump(
    (value) => {
      signal = value;
      return opened.promise;
    },
    () => {},
  );
  pump.push(new Uint8Array([1, 0]));
  expect(await pump.finish()).toBeNull();
  expect(signal?.aborted).toBe(true);
  const cancelled = deferred<void>();
  const session = {
    feed: vi.fn(async () => {}),
    finish: vi.fn(async () => "late"),
    cancel: vi.fn(() => cancelled.resolve()),
  };
  opened.resolve(session);
  await cancelled.promise;
  expect(session.feed).not.toHaveBeenCalled();
  expect(session.cancel).toHaveBeenCalledOnce();
});
