import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";
import { runAttachmentUploadCycle, verifyPersistedAttachmentUpload } from "./attachments.ts";

const environmentId = EnvironmentId.make("environment-1");
const registry = {} as AtomRegistry.AtomRegistry;

type CreateUploadUrlCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentCreateUploadUrlInput },
  AttachmentCreateUploadUrlResult,
  never
>;

type RemoveCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentDeleteInput },
  unknown,
  never
>;

function makeCreateUploadUrl(attachmentId: string): CreateUploadUrlCommand {
  return {
    label: "test:create-upload-url",
    run: async () =>
      AsyncResult.success<AttachmentCreateUploadUrlResult, never>({
        attachmentId,
        relativeUrl: `/api/attachments/upload/${attachmentId}`,
        expiresAt: 1,
      }),
  };
}

const removeCalls: string[] = [];
const remove: RemoveCommand = {
  label: "test:remove",
  run: async (_registry, input) => {
    removeCalls.push(input.input.attachmentId);
    return AsyncResult.success(undefined);
  },
};

const uploadInput: AttachmentCreateUploadUrlInput = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
};

describe("runAttachmentUploadCycle", () => {
  it("leaves a fresh mint to expire when its environment was removed", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-abandoned"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after removal");
      },
      onMinted: () => "abandon" as const,
    });
    expect(result).toEqual({ status: "cancelled", attachmentId: "pending-abandoned" });
    expect(removeCalls).toEqual([]);
  });
  it("reports a failed deletion of a cancelled mint", async () => {
    const failure = new Error("delete denied");
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-denied"),
      remove: {
        label: "test:remove-denied",
        run: async () => AsyncResult.failure(Cause.fail(failure)),
      },
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after cancel");
      },
      onMinted: () => "cancel",
    });
    expect(result).toMatchObject({
      status: "failed",
      step: "cleanup",
      attachmentId: "pending-denied",
      error: failure,
    });
  });
  it("waits for pending upload deletion when cancelled after minting", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let settled = false;
    const result = runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-held"),
      remove: {
        label: "test:remove-held",
        run: async () => {
          started.resolve();
          await finish.promise;
          return AsyncResult.success(undefined);
        },
      },
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after cancel");
      },
      onMinted: () => "cancel",
    }).then((value) => {
      settled = true;
      return value;
    });
    await started.promise;
    await Promise.resolve();
    try {
      expect(settled).toBe(false);
    } finally {
      finish.resolve();
    }
    expect(await result).toEqual({ status: "cancelled", attachmentId: "pending-held" });
  });
  it("deletes the fresh mint when the caller cancels at onMinted", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-cancelled"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after cancel");
      },
      onMinted: () => "cancel",
    });

    expect(result).toEqual({ status: "cancelled", attachmentId: "pending-cancelled" });
    expect(removeCalls).toEqual(["pending-cancelled"]);
  });

  it("keeps the minted id on transfer failure so the caller can retry or release", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-failed"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => ({
        done: Promise.reject(new Error("Upload rejected (413)")),
        abort: () => {},
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      step: "transfer",
      attachmentId: "pending-failed",
    });
    expect(removeCalls).toEqual([]);
  });
});

describe("verifyPersistedAttachmentUpload", () => {
  it("hits the server on every verification instead of reusing a cached failure", async () => {
    let lookups = 0;
    const assetUrlAtom = Atom.make(
      Effect.promise(() => Promise.resolve()).pipe(
        Effect.flatMap(() => {
          lookups += 1;
          return lookups === 1
            ? Effect.fail({ _tag: "TransportError" } as const)
            : Effect.succeed({ url: "/api/assets/pending-1" });
        }),
      ),
    ).pipe(Atom.swr({ staleTime: 60_000 }), Atom.keepAlive);
    const liveRegistry = AtomRegistry.make();

    const verify = () =>
      verifyPersistedAttachmentUpload({
        registry: liveRegistry,
        createAssetUrl: () => assetUrlAtom,
        environmentId,
        attachmentId: "pending-1",
      });

    const first = await verify();
    expect(first).toMatchObject({ status: "failed" });

    const second = await verify();
    expect(second).toEqual({ status: "verified" });
    expect(lookups).toBe(2);
  });
});
