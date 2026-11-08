import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
it.effect("cancels tracked setup before provider work is released", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const renamed = yield* Deferred.make<void>();
    const harness = makeHarness({
      renameBranch: (input) =>
        Deferred.succeed(renamed, undefined).pipe(Effect.as({ branch: input.newBranch })),
      runSetup: () =>
        Deferred.await(renamed).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = launchInput({
        command: "launch:cancel-tracked",
        thread: "thread:cancel-tracked",
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(entered);
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.isNull(projection.thread.worktreePath);
      assert.isNull(projection.thread.branch);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${input.commandId}:release`)));
      assert.deepStrictEqual(
        harness.deleteLocalBranch.mock.calls.map(([call]) => call.refName),
        ["generated-branch"],
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("keeps preparing a worktree when its cancellation watch fails once", () =>
  Effect.gen(function* () {
    const fetchEntered = yield* Deferred.make<void>();
    const allowFetch = yield* Deferred.make<void>();
    const failWatch = yield* Deferred.make<void>();
    const watchFailed = yield* Deferred.make<void>();
    let watchFailures = 1;
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        Deferred.succeed(fetchEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowFetch)),
          Effect.as({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
        ),
      launchEvents: (real) => (input) =>
        input.eventType === "run.updated" && watchFailures-- > 0
          ? Stream.fromEffect(Deferred.await(failWatch)).pipe(
              Stream.flatMap(() =>
                Stream.fail(new Orchestrator.OrchestratorDomainEventStreamError({})),
              ),
              Stream.ensuring(Deferred.succeed(watchFailed, undefined)),
            )
          : real(input),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "launch:watch-fails",
          thread: "thread:watch-fails",
          message: "Start",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        }),
      );
      yield* Deferred.await(fetchEntered);
      yield* Deferred.succeed(failWatch, undefined);
      yield* Deferred.await(watchFailed);
      yield* Deferred.succeed(allowFetch, undefined);
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            (stored.commandId?.endsWith(":release") === true ||
              stored.event.payload.status === "failed"),
        ),
        Stream.runHead,
      );
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.notEqual(projection.runs[0]?.status, "failed");
      assert.isNotNull(projection.thread.worktreePath);
    }).pipe(Effect.provide(harness.layer));
  }),
);
