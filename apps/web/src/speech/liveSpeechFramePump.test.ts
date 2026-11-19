import { expect, it, vi } from "vite-plus/test";
import { LiveSpeechFramePump } from "./liveSpeechFramePump";
import { encodeMonoPcm16Wav } from "@goat/contracts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("streams retained capture samples without copying the startup backlog", async () => {
  const opened = deferred<{
    feed: (bytes: Uint8Array) => Promise<void>;
    finish: () => Promise<string | null>;
    cancel: () => void;
  } | null>();
  const firstFrame = deferred<void>();
  const frames: Uint8Array[] = [];
  const pump = new LiveSpeechFramePump(
    () => opened.promise,
    () => {},
  );
  const samples = new Float32Array(48_004).fill(0.25);
  pump.pushSamples(samples, 48_000);
  samples[0] = 0.5;
  opened.resolve({
    feed: async (frame) => {
      frames.push(frame);
      firstFrame.resolve();
    },
    finish: async () => "complete",
    cancel: () => {},
  });
  pump.pushSamples(new Float32Array(2).fill(0.25), 48_000);
  try {
    await opened.promise;
    expect(frames).toHaveLength(1);
    await firstFrame.promise;
    expect(await pump.finish()).toBe("complete");
    const expected = encodeMonoPcm16Wav([samples, new Float32Array(2).fill(0.25)], 48_000, 16_000);
    if (!expected) throw new Error("invalid fixture");
    expect(Uint8Array.from(frames.flatMap((frame) => [...frame]))).toEqual(
      expected.bytes.subarray(44),
    );
  } finally {
    pump.cancel();
  }
});

it("keeps unsent samples as capture references while a PCM frame is in flight", async () => {
  const opened = deferred<{
    feed: (bytes: Uint8Array) => Promise<void>;
    finish: () => Promise<string | null>;
    cancel: () => void;
  } | null>();
  const first = deferred<void>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const frames: Uint8Array[] = [];
  const pump = new LiveSpeechFramePump(
    () => opened.promise,
    () => {},
  );
  const samples = new Float32Array(96_000).fill(0.25);
  pump.pushSamples(samples, 48_000);
  opened.resolve({
    feed: async (frame) => {
      frames.push(frame);
      if (frames.length === 1) {
        firstStarted.resolve();
        await first.promise;
      } else secondStarted.resolve();
    },
    finish: async () => "complete",
    cancel: () => {},
  });
  try {
    await firstStarted.promise;
    expect(frames).toHaveLength(1);
    samples[48_000] = 0.5;
    first.resolve();
    await secondStarted.promise;
    const view = new DataView(frames[1]!.buffer, frames[1]!.byteOffset, frames[1]!.byteLength);
    expect(view.getInt16(0, true)).toBe(Math.round(0.5 * 32_767));
    expect(await pump.finish()).toBe("complete");
  } finally {
    first.resolve();
    pump.cancel();
  }
});

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

it("falls back when finishing a live stream rejects", async () => {
  const frameReceived = deferred<void>();
  const failed = vi.fn();
  const pump = new LiveSpeechFramePump(
    async () => ({
      feed: async () => {
        frameReceived.resolve();
      },
      finish: async () => {
        throw new Error("disconnected");
      },
      cancel: () => {},
    }),
    failed,
  );
  pump.push(new Uint8Array([1, 0]));
  await frameReceived.promise;
  expect(await pump.finish()).toBeNull();
  expect(failed).toHaveBeenCalledOnce();
});

it("waits for a failed live session to release its worker before batch fallback", async () => {
  const frameReceived = deferred<void>();
  const allowRelease = deferred<void>();
  let fail: () => void = () => {};
  let released = false;
  const pump = new LiveSpeechFramePump(
    async (_signal, onFailure) => {
      fail = onFailure;
      return {
        feed: async () => {
          frameReceived.resolve();
        },
        finish: async () => {
          await allowRelease.promise;
          released = true;
          return null;
        },
        cancel: () => {},
      };
    },
    () => {},
  );
  pump.push(new Uint8Array([1, 0]));
  await frameReceived.promise;
  fail();
  const finishing = pump.finish().then((text) => {
    expect(released).toBe(true);
    return text;
  });
  allowRelease.resolve();
  expect(await finishing).toBeNull();
});
