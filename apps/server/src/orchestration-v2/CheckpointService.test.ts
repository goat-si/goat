import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect.each([0, 1] as const)(
  "reads existing checkpoints under either namespace, candidate %s",
  (candidateIndex) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:goat-refs"),
      threadId: ThreadId.make("thread:goat-refs"),
      runId: RunId.make("run:goat-refs:1"),
      nodeId: NodeId.make("node:goat-refs:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:goat-refs"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const stored = new Set<string>();
    const captureCheckpoint = vi.fn((input: CheckpointStore.RestoreCheckpointInput) =>
      Effect.sync(() => {
        stored.add(input.checkpointRef);
      }),
    );
    const diffCheckpoints = vi.fn(
      (_input: { readonly fromCheckpointRef: string; readonly toCheckpointRef: string }) =>
        Effect.succeed("1\t0\tsrc/a.ts\n"),
    );
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: (input) => Effect.succeed(stored.has(input.checkpointRef)),
            captureCheckpoint,
            diffCheckpoints,
            listAuthoredPaths: () => Effect.succeed(null),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    return Effect.gen(function* () {
      const candidates = yield* CheckpointService.checkpointRefCandidatesForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 0,
      });
      const baseline = candidates[candidateIndex];
      stored.add(baseline);
      const canonical = yield* CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 1,
      });
      assert.match(canonical, /^refs\/goat\/orchestration-v2\/checkpoints\//);
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;

      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      assert.equal(captureCheckpoint.mock.calls.length, 0);

      yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      assert.equal(diffCheckpoints.mock.calls[0]?.[0].fromCheckpointRef, baseline);
      assert.equal(captureCheckpoint.mock.calls[0]?.[0].checkpointRef, canonical);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const captureBaseline = yield* Effect.result(
        checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
      );
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      return {
        baseline: baseline.status,
        turn: turn.status,
        captureBaseline: captureBaseline._tag,
      };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error", captureBaseline: "Failure" });
  }),
);

it.effect("does not treat a failed canonical ref lookup as a missing legacy checkpoint", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:ref-failure"),
      threadId: ThreadId.make("thread:ref-failure"),
      runId: RunId.make("run:ref-failure"),
      nodeId: NodeId.make("node:ref-failure"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:ref-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: ({ checkpointRef }) =>
              checkpointRef.startsWith("refs/goat/")
                ? Effect.fail(
                    new VcsProcessExitError({
                      operation: "test.ref",
                      command: "git",
                      cwd: scope.cwd,
                      exitCode: 1,
                      detail: "unreadable object",
                    }),
                  )
                : Effect.succeed(true),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    const checkpoint = yield* CheckpointService.CheckpointServiceV2.pipe(
      Effect.flatMap((service) =>
        service.materializeBaselineCheckpoint({
          scope,
          ordinalWithinScope: 0,
          nodeId: scope.nodeId,
          capturedAt: scope.createdAt,
        }),
      ),
      Effect.provide(layerTest),
    );
    assert.strictEqual(checkpoint.status, "error");
  }),
);
