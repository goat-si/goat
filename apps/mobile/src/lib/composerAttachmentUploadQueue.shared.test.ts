import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createComposerAttachmentUploadQueue } from "./composerAttachmentUploadQueue";

it.effect("joins delivery to a draft upload through the ownership handoff", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();
    const upload = vi.fn(async () => {
      started.resolve();
      return result.promise;
    });
    const request = {
      environmentId: EnvironmentId.make("environment-1"),
      attachment: {
        id: "one",
        type: "file" as const,
        name: "one.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: "file:///documents/one.pdf",
      },
    };
    const queue = createComposerAttachmentUploadQueue({
      upload,
      onChange: () => {},
      onUploaded: () => Effect.void,
    });
    queue.sync([request]);
    yield* Effect.promise(() => started.promise);
    const sent = yield* Effect.forkChild(queue.upload(request), { startImmediately: true });
    queue.sync([]);
    result.resolve("upload-1");
    expect(yield* Fiber.join(sent)).toBe("upload-1");
    expect(upload).toHaveBeenCalledOnce();
    queue.dispose();
  }),
);

it("settles without retrying an upload after its draft is abandoned", async () => {
  const started = Promise.withResolvers<void>();
  const upload = vi.fn(async (_request: unknown, signal: AbortSignal) => {
    started.resolve();
    return new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
  });
  const queue = createComposerAttachmentUploadQueue({ upload, onChange: () => {} });
  queue.sync([
    {
      environmentId: EnvironmentId.make("environment-1"),
      attachment: {
        id: "discarded",
        type: "file",
        name: "discarded.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: "file:///documents/discarded.pdf",
      },
    },
  ]);
  await started.promise;
  queue.sync([]);
  await queue.settled();
  expect(upload).toHaveBeenCalledOnce();
  queue.dispose();
});
