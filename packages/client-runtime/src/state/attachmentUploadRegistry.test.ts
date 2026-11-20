import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { createAttachmentUploadRegistry } from "./attachmentUploadRegistry.ts";

it.effect("shares an in-flight transfer across holders while isolating environments", () =>
  Effect.gen(function* () {
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
    const bothStarted = Promise.withResolvers<void>();
    const upload = vi.fn((request: { environmentId: string; attachmentId: string }) => {
      const transfer = Promise.withResolvers<string>();
      pending.set(request.environmentId, transfer);
      if (pending.size === 2) bothStarted.resolve();
      return transfer.promise;
    });
    const registry = createAttachmentUploadRegistry({
      key: (request: { environmentId: string; attachmentId: string }) =>
        JSON.stringify([request.environmentId, request.attachmentId]),
      upload,
      error: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      onChange: () => {},
    });
    const first = { environmentId: "one", attachmentId: "file" };
    const second = { environmentId: "two", attachmentId: "file" };
    registry.sync([first, second]);
    const joined = yield* Effect.forkChild(registry.upload(first), { startImmediately: true });
    yield* Effect.promise(() => bothStarted.promise);
    expect(upload).toHaveBeenCalledTimes(2);
    registry.sync([second]);
    pending.get("one")?.resolve("uploaded-one");
    pending.get("two")?.resolve("uploaded-two");
    expect(yield* Fiber.join(joined)).toBe("uploaded-one");
    yield* Effect.promise(() => registry.settled());
    expect(upload).toHaveBeenCalledTimes(2);
    registry.dispose();
  }),
);
