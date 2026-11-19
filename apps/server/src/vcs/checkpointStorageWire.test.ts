import { describe, expect, it } from "@effect/vitest";
import {
  VcsError,
  ReviewDiffPreviewError,
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  GitCommandError,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { privateCheckpointObjects } from "./checkpointPrivateObjects.ts";
import { VcsCheckpointStorageError, mapCheckpointStorageError } from "./checkpointStorageError.ts";

// Frozen from the integration base's packages/contracts/src/vcs.ts.
const previousVcsError = Schema.Union([
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
]);
const previousReviewError = Schema.Union([previousVcsError, GitCommandError]);
describe("checkpoint storage failures at VCS boundaries", () => {
  it.each([
    { boundary: "vcs.init", schema: VcsError, previous: previousVcsError },
    {
      boundary: "review diff preview",
      schema: ReviewDiffPreviewError,
      previous: previousReviewError,
    },
    { boundary: "review diff file", schema: ReviewDiffPreviewError, previous: previousReviewError },
  ])("encodes and decodes $boundary using the previous contract", ({ schema, previous }) => {
    const failure = new VcsCheckpointStorageError({
      operation: "checkpoint.capture",
      cwd: "/repo",
      stage: "publish",
      cause: "disk error",
    });
    const mapped = mapCheckpointStorageError(failure);
    const encoded = Schema.encodeUnknownSync(schema)(mapped);
    const decoded = Schema.decodeSync(previous)(encoded);
    expect(decoded._tag).toBe("VcsProcessExitError");
    expect(decoded.message).toContain("publish checkpoint objects");
  });
});

it.effect("keeps the internal publish stage before it is mapped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const common = yield* fs.makeTempDirectoryScoped({ prefix: "checkpoint-internal-stage-" });
      yield* fs.makeDirectory(path.join(common, "objects"));
      const failedLinkFs = {
        ...fs,
        link: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "BadResource",
              module: "FileSystem",
              method: "link",
            }),
          ),
      };
      const privateStore = yield* privateCheckpointObjects(
        failedLinkFs,
        path,
        common,
        "/repo",
        "checkpoint.capture",
      );
      const fanout = path.join(privateStore.env.GIT_OBJECT_DIRECTORY, "ab");
      yield* fs.makeDirectory(fanout);
      yield* fs.writeFileString(path.join(fanout, "1".repeat(38)), "object");
      const failure = yield* privateStore.publish().pipe(Effect.flip);
      expect(failure._tag).toBe("VcsCheckpointStorageError");
      expect(failure.stage).toBe("publish");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
