import { describe, expect, it } from "@effect/vitest";
import {
  WS_METHODS,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import type * as RpcSession from "../rpc/session.ts";
import { createReviewEnvironmentAtoms } from "./review.ts";
import {
  makeEnvironmentQueryHarness,
  QUERY_ENVIRONMENT,
  TestQueryError,
} from "./runtimeTestSupport.ts";

describe("review preview", () => {
  it.effect("publishes tracked metadata before untracked preparation completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const completeStarted = yield* Deferred.make<void>();
        const sawTracked = yield* Deferred.make<ReviewDiffPreviewResult>();
        const sawComplete = yield* Deferred.make<ReviewDiffPreviewResult>();
        const preview: ReviewDiffPreviewResult = {
          cwd: "/project",
          generatedAt: DateTime.makeUnsafe(0),
          sources: [],
        };
        const rpcSession = {
          client: {
            [WS_METHODS.reviewGetDiffPreview]: (input: ReviewDiffPreviewInput) =>
              input.trackedOnly
                ? Effect.succeed({ ...preview, incomplete: true })
                : Deferred.succeed(completeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(preview),
                  ),
          },
        } as unknown as RpcSession.RpcSession;
        const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession });
        const atom = createReviewEnvironmentAtoms(harness.runtime).diffPreview({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { cwd: "/project", scope: "working-tree", metadataOnly: true },
        });
        const registry = AtomRegistry.make();
        const unsubscribe = registry.subscribe(
          atom,
          (result) => {
            if (!AsyncResult.isSuccess(result)) return;
            if (result.value.incomplete)
              Deferred.doneUnsafe(sawTracked, Exit.succeed(result.value));
            else Deferred.doneUnsafe(sawComplete, Exit.succeed(result.value));
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            registry.dispose();
          }),
        );
        expect((yield* Deferred.await(sawTracked)).incomplete).toBe(true);
        yield* Deferred.await(completeStarted);
        expect(yield* Deferred.isDone(release)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Deferred.await(sawComplete)).incomplete).toBeUndefined();
      }),
    ),
  );
  it.effect("uses an older server's complete response without a second request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>();
        let calls = 0;
        const preview: ReviewDiffPreviewResult = {
          cwd: "/project",
          generatedAt: DateTime.makeUnsafe(0),
          sources: [],
        };
        const rpcSession = {
          client: {
            [WS_METHODS.reviewGetDiffPreview]: () =>
              Effect.sync(() => {
                calls += 1;
                return preview;
              }),
          },
        } as unknown as RpcSession.RpcSession;
        const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession });
        const atom = createReviewEnvironmentAtoms(harness.runtime).diffPreview({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { cwd: "/project", scope: "working-tree", metadataOnly: true },
        });
        const registry = AtomRegistry.make();
        const unsubscribe = registry.subscribe(
          atom,
          (result) => {
            if (AsyncResult.isSuccess(result) && !result.waiting)
              Deferred.doneUnsafe(answered, Exit.void);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            registry.dispose();
          }),
        );
        yield* Deferred.await(answered);
        expect(calls).toBe(1);
      }),
    ),
  );
  it.effect.each([false, true])(
    "keeps a complete preview with untracked files during refresh (failure: %s)",
    (fails) =>
      Effect.scoped(
        Effect.gen(function* () {
          const initial = yield* Deferred.make<void>();
          const refreshStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const settled = yield* Deferred.make<void>();
          let trackedCalls = 0;
          let completeCalls = 0;
          const source = {
            id: "working-tree",
            kind: "working-tree" as const,
            title: "Uncommitted",
            baseRef: "HEAD",
            headRef: null,
            diff: "",
            diffHash: "complete",
            truncated: false,
            patchesDeferred: true,
            files: [{ path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 }],
          };
          const preview: ReviewDiffPreviewResult = {
            cwd: "/project",
            generatedAt: DateTime.makeUnsafe(0),
            sources: [source],
          };
          const rpcSession = {
            client: {
              [WS_METHODS.reviewGetDiffPreview]: (input: ReviewDiffPreviewInput) => {
                if (input.trackedOnly) {
                  trackedCalls++;
                  return Effect.succeed({
                    ...preview,
                    sources: [{ ...source, files: [] }],
                    incomplete: true,
                  });
                }
                completeCalls++;
                if (completeCalls === 1) return Effect.succeed(preview);
                return Deferred.succeed(refreshStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    fails
                      ? Effect.fail(new TestQueryError({ message: "untracked failed" }))
                      : Effect.succeed(preview),
                  ),
                );
              },
            },
          } as unknown as RpcSession.RpcSession;
          const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession });
          const atom = createReviewEnvironmentAtoms(harness.runtime).diffPreview({
            environmentId: QUERY_ENVIRONMENT.environmentId,
            input: { cwd: "/project", scope: "working-tree", metadataOnly: true },
          });
          const registry = AtomRegistry.make();
          const unsubscribe = registry.subscribe(
            atom,
            (result) => {
              if (
                completeCalls === 1 &&
                AsyncResult.isSuccess(result) &&
                !result.waiting &&
                !result.value.incomplete
              )
                Deferred.doneUnsafe(initial, Exit.void);
              if (completeCalls > 1 && !result.waiting && result._tag !== "Initial")
                Deferred.doneUnsafe(settled, Exit.void);
            },
            { immediate: true },
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              unsubscribe();
              registry.dispose();
            }),
          );
          yield* Deferred.await(initial);
          registry.refresh(atom);
          yield* Deferred.await(refreshStarted);
          expect(trackedCalls).toBe(1);
          expect(
            Option.getOrNull(AsyncResult.value(registry.get(atom)))?.sources[0]?.files?.[0]?.path,
          ).toBe("untracked.txt");
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(settled);
          expect(registry.get(atom)._tag).toBe(fails ? "Failure" : "Success");
          expect(
            Option.getOrNull(AsyncResult.value(registry.get(atom)))?.sources[0]?.files?.[0]?.path,
          ).toBe("untracked.txt");
        }),
      ),
  );
});
