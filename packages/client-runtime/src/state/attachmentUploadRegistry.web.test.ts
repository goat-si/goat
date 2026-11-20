import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { createAttachmentUploadRegistry } from "./attachmentUploadRegistry.ts";

interface Request {
  environment: string;
  id: string;
}
const key = (request: Request) => JSON.stringify([request.environment, request.id]);
class TestUploadError extends Data.TaggedError("TestUploadError")<{ readonly message: string }> {}
const error = (cause: unknown) => new TestUploadError({ message: String(cause) });

it.effect("limits each environment independently without starving another", () =>
  Effect.gen(function* () {
    const starts: string[] = [];
    const started = Promise.withResolvers<void>();
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
    const registry = createAttachmentUploadRegistry<Request, TestUploadError>({
      key,
      error,
      concurrency: {
        type: "per-environment",
        limit: 2,
        environment: (request) => request.environment,
      },
      upload: (request) => {
        starts.push(key(request));
        if (starts.length === 3) started.resolve();
        const gate = Promise.withResolvers<string>();
        gates.set(key(request), gate);
        return gate.promise;
      },
      onChange: () => {},
    });
    const requests = ["1", "2", "3"].map((id) => ({ environment: "a", id }));
    const other = { environment: "b", id: "1" };
    registry.sync([...requests, other]);
    yield* Effect.promise(() => started.promise);
    expect(starts).toHaveLength(3);
    expect(starts).toContain(key(other));
    expect(starts.filter((id) => id.includes('"a"'))).toHaveLength(2);
    for (const gate of gates.values()) gate.resolve("done");
    registry.dispose();
  }),
);

it.effect("independent holders share a transfer and releasing one keeps it alive", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();
    const upload = vi.fn((_request: Request, signal: AbortSignal) => {
      signal.addEventListener("abort", () => result.reject(new Error("aborted")), { once: true });
      started.resolve();
      return result.promise;
    });
    const registry = createAttachmentUploadRegistry<Request, TestUploadError>({
      key,
      error,
      concurrency: { type: "global", limit: 3 },
      upload,
      onChange: () => {},
    });
    const request = { environment: "a", id: "one" };
    const first = registry.hold(request);
    const second = registry.hold(request);
    yield* Effect.promise(() => started.promise);
    first();
    const joined = yield* Effect.forkChild(registry.upload(request), { startImmediately: true });
    result.resolve("uploaded");
    expect(yield* Fiber.join(joined)).toBe("uploaded");
    expect(upload).toHaveBeenCalledOnce();
    second();
    registry.dispose();
  }),
);

it.effect("retries a failed transfer held independently and joins the retry", () =>
  Effect.gen(function* () {
    const retryStarted = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => {
        retryStarted.resolve();
        return result.promise;
      });
    const registry = createAttachmentUploadRegistry<Request, TestUploadError>({
      key,
      error,
      concurrency: { type: "global", limit: 3 },
      upload,
      onChange: () => {},
    });
    const request = { environment: "a", id: "one" };
    const release = registry.hold(request);
    yield* Effect.promise(() => registry.settled());
    registry.retry(key(request));
    yield* Effect.promise(() => retryStarted.promise);
    const joined = yield* Effect.forkChild(registry.upload(request), { startImmediately: true });
    result.resolve("uploaded");
    expect(yield* Fiber.join(joined)).toBe("uploaded");
    expect(upload).toHaveBeenCalledTimes(2);
    release();
    registry.dispose();
  }),
);

it.effect("rejects holders beyond the named registry limit", () =>
  Effect.gen(function* () {
    const registry = createAttachmentUploadRegistry<Request, TestUploadError>({
      key,
      error,
      concurrency: { type: "global", limit: 1 },
      maxHolders: 2,
      upload: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      onChange: () => {},
    });
    registry.hold({ environment: "a", id: "1" });
    registry.hold({ environment: "a", id: "2" });
    expect(() => registry.hold({ environment: "a", id: "3" })).toThrow(
      "Upload holder limit reached",
    );
    registry.dispose();
    yield* Effect.void;
  }),
);

it.effect("releasing the last holder aborts its transfer and settled waits for cleanup", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<string>();
    const registry = createAttachmentUploadRegistry<Request, TestUploadError>({
      key,
      error,
      concurrency: { type: "global", limit: 3 },
      onChange: () => {},
      upload: (_request, signal) => {
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        started.resolve();
        return cleanup.promise;
      },
    });
    const release = registry.hold({ environment: "a", id: "one" });
    yield* Effect.promise(() => started.promise);
    release();
    yield* Effect.promise(() => aborted.promise);
    cleanup.resolve("aborted");
    yield* Effect.promise(() => registry.settled());
    registry.dispose();
  }),
);

it.effect("awaits one attachment without waiting for unrelated uploads", () =>
  Effect.gen(function* () {
    const bothStarted = Promise.withResolvers<void>();
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
    const registry = createAttachmentUploadRegistry<Request, TestUploadError>({
      key,
      error,
      concurrency: { type: "global", limit: 3 },
      onChange: () => {},
      upload: (request, signal) => {
        const gate = Promise.withResolvers<string>();
        signal.addEventListener("abort", () => gate.reject(new Error("aborted")), { once: true });
        gates.set(key(request), gate);
        if (gates.size === 2) bothStarted.resolve();
        return gate.promise;
      },
    });
    const one = { environment: "a", id: "one" };
    const two = { environment: "a", id: "two" };
    registry.sync([one, two]);
    yield* Effect.promise(() => bothStarted.promise);
    gates.get(key(one))?.resolve("done");
    yield* Effect.promise(() => registry.settled(key(one)));
    expect(gates.size).toBe(2);
    registry.dispose();
  }),
);
