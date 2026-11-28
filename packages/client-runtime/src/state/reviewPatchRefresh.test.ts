import { expect, it, vi } from "@effect/vitest";
import { WS_METHODS, type ReviewDiffPreviewInput } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as RpcSession from "../rpc/session.ts";
import { createReviewEnvironmentAtoms } from "./review.ts";
import {
  QUERY_ENVIRONMENT,
  makeEnvironmentQueryHarness,
  mountEnvironmentQuery,
  readEnvironmentQuery,
} from "./runtimeTestSupport.ts";

it.effect("does not re-read a file patch read while its preview was revalidating", () =>
  Effect.gen(function* () {
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    const previewStarted = yield* Deferred.make<void>();
    const releasePreview = yield* Deferred.make<void>();
    let previewReads = 0;
    let patchReads = 0;
    const rpcSession = {
      client: {
        [WS_METHODS.reviewGetDiffPreview]: (input: ReviewDiffPreviewInput) =>
          Effect.gen(function* () {
            if (input.file) patchReads += 1;
            else if (++previewReads > 1) {
              yield* Deferred.succeed(previewStarted, undefined);
              yield* Deferred.await(releasePreview);
            }
            return {
              cwd: input.cwd,
              generatedAt: DateTime.makeUnsafe(previewReads),
              sources: [
                {
                  id: "working-tree",
                  kind: "working-tree" as const,
                  title: "Uncommitted",
                  baseRef: "HEAD",
                  headRef: null,
                  diff: "",
                  diffHash: "same",
                  truncated: false,
                  patchesDeferred: true,
                  files: [{ path: "a.ts", previousPath: null, additions: 1, deletions: 0 }],
                },
              ],
            };
          }),
      },
    } as unknown as RpcSession.RpcSession;
    const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession });
    const review = createReviewEnvironmentAtoms(harness.runtime);
    const previewInput = {
      cwd: "/project",
      scope: "working-tree",
      metadataOnly: true,
    } as const;
    const preview = review.diffPreview({
      environmentId: QUERY_ENVIRONMENT.environmentId,
      input: previewInput,
    });
    const registry = yield* mountEnvironmentQuery(preview);
    yield* readEnvironmentQuery(registry, preview);

    // Opening the Diff panel revalidates the preview and reads the visible patches at once.
    registry.refresh(preview);
    yield* Deferred.await(previewStarted);
    const patch = review.diffFilePatch({
      environmentId: QUERY_ENVIRONMENT.environmentId,
      input: {
        request: {
          cwd: "/project",
          scope: "working-tree",
          file: { sourceKind: "working-tree", path: "a.ts", previousPath: null },
        },
        cacheKey: "a.ts",
        preview: previewInput,
      },
    });
    registry.mount(patch);
    yield* readEnvironmentQuery(registry, patch);
    expect(patchReads).toBe(1);

    yield* Deferred.succeed(releasePreview, undefined);
    yield* readEnvironmentQuery(registry, preview);
    yield* readEnvironmentQuery(registry, patch);
    expect(patchReads).toBe(1);

    // A revalidation requested after the patch was read still refreshes it.
    now = 1;
    registry.refresh(preview);
    yield* readEnvironmentQuery(registry, preview);
    yield* readEnvironmentQuery(registry, patch);
    expect(patchReads).toBe(2);
  }),
);
