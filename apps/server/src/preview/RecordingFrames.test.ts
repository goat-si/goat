import { expect, it, vi } from "vite-plus/test";
import { makeRecordingFrames } from "./RecordingFrames.ts";

it("acknowledges promptly and keeps only the newest frame while encoding stalls", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  const acknowledge = vi.fn(async (_id: number) => {});
  const encode = vi.fn((data: string) => {
    if (data === "one") {
      started.resolve();
      return release.promise;
    }
    return Promise.resolve(true);
  });
  const frames = makeRecordingFrames({
    acknowledge,
    encode,
    stop: async () => {},
    isPrivate: () => false,
  });
  frames.offer({ data: "one", width: 100, sessionId: 1 });
  await started.promise;
  frames.offer({ data: "two", width: 100, sessionId: 2 });
  frames.offer({ data: "three", width: 100, sessionId: 3 });
  expect(acknowledge.mock.calls.map(([id]) => id)).toEqual([1, 2, 3]);
  release.resolve(true);
  await frames.finish();
  expect(encode.mock.calls.map(([data]) => data)).toEqual(["one", "three"]);
});

it("acknowledges private frames without encoding them", async () => {
  const acknowledge = vi.fn(async () => {});
  const encode = vi.fn(async () => true);
  const frames = makeRecordingFrames({
    acknowledge,
    encode,
    stop: async () => {},
    isPrivate: () => true,
  });
  frames.offer({ data: "secret", width: 100, sessionId: 1 });
  await frames.finish();
  expect(acknowledge).toHaveBeenCalledOnce();
  expect(encode).not.toHaveBeenCalled();
});

it("reports encoder failure and stops the screencast", async () => {
  const stop = vi.fn(async () => {});
  const frames = makeRecordingFrames({
    acknowledge: async () => {},
    encode: async () => {
      throw new Error("encoder failed");
    },
    stop,
    isPrivate: () => false,
  });
  frames.offer({ data: "frame", width: 100, sessionId: 1 });
  await expect(frames.finish()).rejects.toThrow("encoder failed");
  expect(stop).toHaveBeenCalledOnce();
});

it("bounds stalled acknowledgements and reports the failure", async () => {
  const ack = Promise.withResolvers<void>();
  const stop = vi.fn(async () => {});
  const acknowledge = vi.fn(() => ack.promise);
  const frames = makeRecordingFrames({
    acknowledge,
    encode: async () => true,
    stop,
    isPrivate: () => false,
  });
  for (let sessionId = 0; sessionId < 33; sessionId++)
    frames.offer({ data: "frame", width: 100, sessionId });
  expect(acknowledge).toHaveBeenCalledTimes(32);
  ack.resolve();
  await expect(frames.finish()).rejects.toThrow("acknowledgements are stalled");
  expect(stop).toHaveBeenCalledOnce();
});

it("finishes and cleans up when acknowledgements never settle", async () => {
  const ack = Promise.withResolvers<void>();
  const stop = vi.fn(async () => {});
  const cleanup = vi.fn();
  const frames = makeRecordingFrames({
    acknowledge: () => ack.promise,
    encode: async () => true,
    stop,
    isPrivate: () => true,
  });
  frames.offer({ data: "frame", width: 100, sessionId: 0 });
  const finished = frames.finish().finally(cleanup);
  for (let sessionId = 1; sessionId < 33; sessionId++)
    frames.offer({ data: "frame", width: 100, sessionId });
  await expect(finished).rejects.toThrow("acknowledgements are stalled");
  expect(stop).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});
