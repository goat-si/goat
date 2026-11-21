import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import {
  createComposerAttachmentUploadQueue,
  composerAttachmentUploadKey,
} from "./composerAttachmentUploadQueue";

const request = {
  environmentId: EnvironmentId.make("environment-1"),
  attachment: {
    id: "one",
    type: "file" as const,
    name: "one.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    fileUri: "file:///one.txt",
  },
};

it.effect("retries a failed outbox-held upload once and reaches ready", () =>
  Effect.gen(function* () {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue("uploaded");
    let states: Readonly<Record<string, { status: string }>> = {};
    const queue = createComposerAttachmentUploadQueue({
      upload,
      onChange: (next) => {
        states = next;
      },
    });
    queue.sync([request]);
    yield* Effect.promise(() => queue.settled());
    expect(
      states[composerAttachmentUploadKey(request.environmentId, request.attachment.id)]?.status,
    ).toBe("failed");
    expect(yield* queue.upload(request)).toBe("uploaded");
    yield* Effect.promise(() => queue.settled());
    expect(upload).toHaveBeenCalledTimes(2);
    expect(
      states[composerAttachmentUploadKey(request.environmentId, request.attachment.id)]?.status,
    ).toBe("ready");
    queue.dispose();
  }),
);

it.effect("joining an in-flight retry starts no second transfer", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<string>();
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockImplementationOnce(async () => {
        started.resolve();
        return gate.promise;
      });
    const queue = createComposerAttachmentUploadQueue({ upload, onChange: () => {} });
    queue.sync([request]);
    yield* Effect.promise(() => queue.settled());
    const first = yield* Effect.forkChild(queue.upload(request), { startImmediately: true });
    yield* Effect.promise(() => started.promise);
    const second = yield* Effect.forkChild(queue.upload(request), { startImmediately: true });
    gate.resolve("uploaded");
    expect(yield* Fiber.join(first)).toBe("uploaded");
    expect(yield* Fiber.join(second)).toBe("uploaded");
    expect(upload).toHaveBeenCalledTimes(2);
    queue.dispose();
  }),
);
