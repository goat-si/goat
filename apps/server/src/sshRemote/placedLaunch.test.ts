// @effect-diagnostics nodeBuiltinImport:off - the upload test writes a scratch file.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChatAttachmentId, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@goat/contracts";
import * as FileSystem from "effect/FileSystem";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readAttachmentExactly } from "../fleet/admission/PlacementDigest.ts";
import { attachmentBody } from "./placedLaunch.ts";
import { launchAgainst } from "./SshRemoteDispatch.lineage.testkit.ts";
import type { SshRemoteDispatchError } from "./dispatchFailure.ts";

const placement = { ownerKey: "goal:g1:a1", attempt: 0, issuedAt: "2026-11-01T00:00:00.000Z" };
const declares = {
  declaresLaunchedBy: false,
  outside: true,
  declaresReport: true,
  declaresStandingInstructions: true,
} as const;

const refusedWith = (remote: Parameters<typeof launchAgainst>[0]) =>
  launchAgainst(remote).pipe(
    Effect.flip,
    Effect.map((error) => error as SshRemoteDispatchError),
  );

it.effect(
  "a placed launch sends its key to a remote whose fresh listing declares placement and needs the remote's started answer",
  () =>
    Effect.gen(function* () {
      const { result, launches } = yield* launchAgainst({
        ...declares,
        declaresPlacement: true,
        placement,
        launchAnswer: { placement: { outcome: "started" } },
      });
      assert.strictEqual(result.threadId, "new-thread");
      assert.deepStrictEqual(launches.at(-1)?.placement, placement);
      const ignored = yield* refusedWith({ ...declares, declaresPlacement: true, placement });
      assert.isTrue(ignored.launchMayHaveStarted);
    }),
);

it.effect("a remote that does not declare placement is refused before anything is sent", () =>
  Effect.gen(function* () {
    const error = yield* refusedWith({ ...declares, placement });
    assert.strictEqual(error.remoteClassification, "placement_unsupported");
    assert.isFalse(error.launchMayHaveStarted);
  }),
);

it.effect(
  "a failed fresh listing refuses the placement even when an earlier listing on this session was cached",
  () =>
    Effect.gen(function* () {
      const error = yield* refusedWith({
        ...declares,
        declaresPlacement: true,
        placementOnSecondLaunch: placement,
        afterFirstLaunch: {
          advertisesMemory: false,
          declaresMemoryCeiling: false,
          listFailure: "failed",
        },
      });
      assert.strictEqual(error.remoteClassification, "placement_unsupported");
      assert.isFalse(error.launchMayHaveStarted);
    }),
);

it.effect(
  "placement refusals keep their classification, idle thread and uncertainty through the transport",
  () =>
    Effect.gen(function* () {
      const notStarted = yield* refusedWith({
        ...declares,
        declaresPlacement: true,
        placement,
        launchRefusal: {
          _tag: "OrchestratorMcpFailure",
          code: "conflict",
          message: "This placement did not start here: lease lapsed.",
          classification: "placement_not_started",
          mayHaveStarted: false,
          threadId: "placement:abc",
        },
      });
      assert.strictEqual(notStarted.remoteClassification, "placement_not_started");
      assert.strictEqual(notStarted.remoteThreadId, "placement:abc");
      assert.isFalse(notStarted.launchMayHaveStarted);
      // A payload that does not say whether the work started counts as possibly started.
      const pending = yield* refusedWith({
        ...declares,
        declaresPlacement: true,
        placement,
        launchRefusal: {
          code: "conflict",
          message: "still pending",
          classification: "placement_pending",
        },
      });
      assert.strictEqual(pending.remoteClassification, "placement_pending");
      assert.isTrue(pending.launchMayHaveStarted);
    }),
);

it.effect(
  "a placed upload sends the frozen bytes from memory, and bytes changed since the key was made send nothing",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "placed-upload-")),
        "a.txt",
      );
      const attachment = {
        type: "file" as const,
        id: ChatAttachmentId.make("pending-a"),
        name: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      NodeFS.writeFileSync(path, "first");
      const frozen = NodeCrypto.createHash("sha256").update("first").digest("hex");
      yield* attachmentBody(fileSystem, path, attachment, frozen);
      // Same size, other bytes: the upload refuses before anything reaches the remote.
      NodeFS.writeFileSync(path, "other");
      const changed = yield* attachmentBody(fileSystem, path, attachment, frozen).pipe(Effect.flip);
      assert.strictEqual(changed.reason, "invalid_request");
      assert.isFalse(changed.launchMayHaveStarted);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a placed attachment is read only at its declared size within the attachment limit: a longer file or an oversized declaration reads nothing",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "placed-read-")),
        "a.txt",
      );
      const attachment = {
        type: "file" as const,
        id: ChatAttachmentId.make("pending-a"),
        name: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      NodeFS.writeFileSync(path, "first");
      const exact = yield* readAttachmentExactly(fileSystem, path, attachment);
      assert.strictEqual(new TextDecoder().decode(exact ?? new Uint8Array()), "first");
      // The file grew after it was checked: the read stops one byte past the declared size.
      NodeFS.writeFileSync(path, "first and much more");
      assert.isNull(yield* readAttachmentExactly(fileSystem, path, attachment));
      assert.isNull(
        yield* readAttachmentExactly(fileSystem, path, {
          type: "image",
          sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
        }),
      );
      assert.isNull(yield* readAttachmentExactly(fileSystem, path + ".gone", attachment));
    }).pipe(Effect.provide(NodeServices.layer)),
);
