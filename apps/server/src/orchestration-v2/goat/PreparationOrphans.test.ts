import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GitCommandError,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ThreadLaunch from "../ThreadLaunchService.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { preparationSettled } from "../testkit/preparationSettled.ts";
import { makeHarness, project } from "../testkit/ThreadLaunchHarness.ts";
import { launchInput } from "../testkit/threadLaunchInput.ts";
import { PreparationClaims } from "./PreparationClaims.ts";
import { makeClaimProbe, makeLaunchHold } from "./PreparationClaims.testkit.ts";
import {
  NOT_STARTED_MESSAGE,
  RECOVERY_INDEX_STATUSES,
  SUSPECTS_QUERY,
} from "./PreparationOrphans.ts";
import { makeOrphanProbe, orphanRun, released, runStatus } from "./PreparationOrphans.testkit.ts";

type Harness = ReturnType<typeof makeHarness>;
type Probe = Effect.Success<typeof makeOrphanProbe>;

const withCheck = (harness: Harness, probe: Probe) =>
  Layer.mergeAll(harness.layer, probe.layer.pipe(Layer.provide(harness.layer)));

/** Passes at 1, 2 and 3 minutes find the run; the first read it, so the fourth fails it. */
const passesBeforeGrace = <E, R>(probe: Probe, still: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    for (let pass = 1; pass <= 3; pass++) {
      assert.equal(yield* probe.pass, "read");
      yield* still;
    }
  });

/** A preparation failure and a Retry, neither by the check, with nothing then preparing the run. */
const failAndRetry = (threadId: ThreadId, runId: RunId, name: string, cycle: number) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "prepared-run.fail",
      commandId: CommandId.make(`command:${name}:fail-${cycle}`),
      threadId,
      runId,
      failure: makeProviderFailure({ message: `Cycle ${cycle} failed.` }),
    });
    yield* threads.dispatch({
      type: "prepared-run.retry",
      commandId: CommandId.make(`command:${name}:retry-${cycle}`),
      threadId,
      runId,
    });
  });

const errorMessage = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const item = (yield* threads.getThreadProjection(threadId)).turnItems.find(
      (candidate) => candidate.runId === runId && candidate.type === "error",
    );
    return item?.type === "error" ? item.failure.message : undefined;
  });

it.effect(
  "the check's status list is the recovery index's condition, so its read searches that index",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [index] = yield* sql`
        SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_projection_runs_recovery_idx'
      `;
      const statuses = RECOVERY_INDEX_STATUSES.map((status) => `'${status}'`).join(", ");
      assert.include(String(index?.sql), `WHERE status IN (${statuses})`);
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${SUSPECTS_QUERY}`,
      );
      assert.deepEqual(
        plan.map((row) => row.detail),
        [
          "MATERIALIZE oldest",
          "SEARCH orchestration_v2_projection_runs USING INDEX orchestration_v2_projection_runs_recovery_idx (status=?)",
          "USE TEMP B-TREE FOR ORDER BY",
          "SCAN oldest",
          "CORRELATED SCALAR SUBQUERY 2",
          "SEARCH item USING INDEX orchestration_v2_projection_turn_items_run_ordinal_idx (run_id=?)",
        ],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a run left preparing with nothing preparing it is failed between the grace period and one interval later, says preparation did not finish, and Retry prepares it",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { threadId, runId } = yield* orphanRun("orphan");
        const preparing = runStatus(threadId, runId).pipe(
          Effect.map((status) => assert.equal(status, "preparing")),
        );
        // The third pass is the grace period after the run's commit.
        yield* passesBeforeGrace(probe, preparing);
        assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.failed, runId);

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "failed");
        const failedItems = projection.turnItems.filter(
          (item) => item.runId === runId && item.status === "failed",
        );
        assert.deepEqual(
          failedItems.map((item) => item.title),
          ["Workspace preparation did not finish", "Workspace preparation did not finish"],
        );
        const error = failedItems.find((item) => item.type === "error");
        assert.ok(error?.type === "error");
        assert.equal(error.failure.code, ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE);
        assert.equal(error.failure.message, NOT_STARTED_MESSAGE);

        yield* launches.retryPreparation({
          commandId: CommandId.make("command:orphan:retry"),
          threadId,
          runId,
        });
        yield* released(threadId, "command:orphan:retry");
        assert.notInclude(["preparing", "failed"], yield* runStatus(threadId, runId));
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect("a run whose preparation is under way is not failed, however long it takes", () =>
  Effect.gen(function* () {
    const probe = yield* makeOrphanProbe;
    const entered = yield* Deferred.make<void>();
    const allow = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: (request) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(allow)),
          Effect.as({
            worktree: { path: "/repo-worktrees/slow", refName: request.newRefName, headSha: "abc" },
          } as never),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:slow",
          thread: "thread:slow",
          message: "Prepare slowly",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      const runId = launched.projection.runs[0]!.id;
      yield* Deferred.await(entered);
      // Ten grace periods.
      for (let pass = 1; pass <= 30; pass++) assert.equal(yield* probe.pass, "read");
      assert.equal(yield* runStatus(launched.threadId, runId), "preparing");
      assert.equal(yield* probe.failCount, 0);

      yield* Deferred.succeed(allow, undefined);
      yield* released(launched.threadId, "command:slow");
    }).pipe(Effect.provide(withCheck(harness, probe)));
  }),
);

it.effect("a run retried right after a real preparation failure is not failed early", () =>
  Effect.gen(function* () {
    const probe = yield* makeOrphanProbe;
    const hold = yield* makeLaunchHold;
    const entered = yield* Deferred.make<void>();
    const fail = yield* Deferred.make<void>();
    let worktrees = 0;
    const harness = makeHarness({
      launchThreads: hold.wrap,
      createWorktree: (request) =>
        worktrees++ === 0
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(fail)),
              Effect.andThen(
                Effect.fail(
                  new GitCommandError({
                    operation: "GitVcsDriver.createWorktree",
                    command: "git worktree add",
                    cwd: project.workspaceRoot,
                    detail: "The branch is checked out elsewhere.",
                  }),
                ),
              ),
            )
          : Effect.succeed({
              worktree: {
                path: "/repo-worktrees/retried",
                refName: request.newRefName,
                headSha: "abc",
              },
            } as never),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:retried",
          thread: "thread:retried",
          message: "Prepare, fail, retry",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      const runId = launched.projection.runs[0]!.id;
      yield* Deferred.await(entered);
      // Passes at 1, 2 and 3 minutes find the run while its preparation runs.
      for (let pass = 1; pass <= 3; pass++) assert.equal(yield* probe.pass, "read");
      yield* Deferred.succeed(fail, undefined);
      assert.equal((yield* preparationSettled(launched.threadId)).runs[0]?.status, "failed");

      // A person retries at once; the next pass lands before the Retry's preparation claims the run.
      yield* hold.arm;
      const retry = yield* launches
        .retryPreparation({
          commandId: CommandId.make("command:retried:retry"),
          threadId: launched.threadId,
          runId,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* hold.held;
      assert.equal(yield* probe.pass, "read");
      yield* hold.resume;
      yield* Fiber.join(retry);
      const outcome = yield* Effect.raceFirst(
        probe.failed.pipe(Effect.as("failed early")),
        released(launched.threadId, "command:retried:retry").pipe(Effect.as("prepared")),
      );
      assert.equal(outcome, "prepared");
    }).pipe(Effect.provide(withCheck(harness, probe)));
  }),
);

it.effect.each(["fail", "die"] as const)(
  "a pass whose read ends with %s fails nothing, and the next pass still fails the orphan",
  (failure) =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const { threadId, runId } = yield* orphanRun(`orphan-${failure}`);
        yield* Ref.set(probe.mode, failure);
        for (let pass = 1; pass <= 4; pass++) assert.equal(yield* probe.pass, failure);
        assert.equal(yield* runStatus(threadId, runId), "preparing");

        yield* Ref.set(probe.mode, "read");
        yield* passesBeforeGrace(probe, Effect.void);
        assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.failed, runId);
        assert.equal(yield* runStatus(threadId, runId), "failed");
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect("a run retried and stuck again is failed again", () =>
  Effect.gen(function* () {
    const probe = yield* makeOrphanProbe;
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId, runId } = yield* orphanRun("stuck-again");
      yield* passesBeforeGrace(probe, Effect.void);
      assert.equal(yield* probe.pass, "read");
      assert.equal(yield* probe.failed, runId);

      // A Retry cut before its preparation started.
      yield* threads.dispatch({
        type: "prepared-run.retry",
        commandId: CommandId.make("command:stuck-again:retry"),
        threadId,
        runId,
      });
      const preparing = runStatus(threadId, runId).pipe(
        Effect.map((status) => assert.equal(status, "preparing")),
      );
      yield* preparing;
      yield* passesBeforeGrace(probe, preparing);
      assert.equal(yield* probe.pass, "read");
      assert.equal(yield* probe.failed, runId);
      assert.equal(yield* runStatus(threadId, runId), "failed");
    }).pipe(Effect.provide(withCheck(harness, probe)));
  }),
);

it.effect(
  "a launch held between its commit and its scheduling for ten grace periods is not failed, and prepares the run when it goes on",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const hold = yield* makeLaunchHold;
      const harness = makeHarness({ launchThreads: hold.wrap });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* hold.arm;
        const launch = yield* launches
          .launch(
            launchInput({
              command: "command:held-launch",
              thread: "thread:held-launch",
              message: "Later",
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* hold.held;
        const threadId = ThreadId.make("thread:held-launch");
        const runId = (yield* threads.getThreadProjection(threadId)).runs[0]!.id;
        for (let pass = 1; pass <= 30; pass++) assert.equal(yield* probe.pass, "read");
        assert.equal(yield* runStatus(threadId, runId), "preparing");
        assert.equal(yield* probe.failCount, 0);

        yield* hold.resume;
        yield* Fiber.join(launch);
        yield* released(threadId, "command:held-launch");
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a launch cut between its commit and its scheduling leaves the run unowned, so the check fails it within the usual window after the cut and Retry prepares it",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const hold = yield* makeLaunchHold;
      const harness = makeHarness({ launchThreads: hold.wrap });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const claims = yield* PreparationClaims;
        const { input, threadId, runId } = yield* orphanRun("cut-launch");
        yield* hold.arm;
        const launch = yield* launches
          .launch(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* hold.held;
        const preparing = runStatus(threadId, runId).pipe(
          Effect.map((status) => assert.equal(status, "preparing")),
        );
        // Past the grace period while the launch owns the run.
        for (let pass = 1; pass <= 4; pass++) {
          assert.equal(yield* probe.pass, "read");
          yield* preparing;
        }
        yield* Fiber.interrupt(launch);
        assert.isFalse(yield* claims.isPending(threadId));

        // Passes 5, 6 and 7 find it unowned; the eighth, four minutes after the cut, fails it.
        yield* passesBeforeGrace(probe, preparing);
        assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.failed, runId);
        yield* launches.retryPreparation({
          commandId: CommandId.make("command:cut-launch:retry"),
          threadId,
          runId,
        });
        yield* released(threadId, "command:cut-launch:retry");
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a Retry made while the check still holds the run's claim after failing it waits for the claim and prepares the run",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const claims = yield* makeClaimProbe;
      const harness = makeHarness({ claims: claims.layer });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const { threadId, runId } = yield* orphanRun("retry-under-check");
        const held = yield* probe.holdAfterFail;
        yield* passesBeforeGrace(probe, Effect.void);
        assert.equal(yield* probe.pass, "read");
        yield* held.committed;

        // Returns once the Retry's preparation is in line for the claim the check still holds.
        yield* launches.retryPreparation({
          commandId: CommandId.make("command:retry-under-check:retry"),
          threadId,
          runId,
        });
        yield* held.release;
        assert.deepEqual(yield* claims.outcome, { runId, ran: true });
        yield* released(threadId, "command:retry-under-check:retry");
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a run failed and retried between the check's read and its claim is not failed on that read, and gets a full grace period",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const claims = yield* makeClaimProbe;
      const harness = makeHarness({ claims: claims.layer });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { threadId, runId } = yield* orphanRun("changed-under-read");
        const preparing = runStatus(threadId, runId).pipe(
          Effect.map((status) => assert.equal(status, "preparing")),
        );
        yield* passesBeforeGrace(probe, preparing);
        // The fourth pass reads the run as due, then waits before claiming it.
        const goOn = yield* probe.holdPass;
        // Meanwhile its preparation fails and a Retry, cut before its own preparation, brings it back.
        yield* threads.dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make("command:changed-under-read:fail"),
          threadId,
          runId,
          failure: makeProviderFailure({ message: "Git could not reach the remote." }),
        });
        yield* threads.dispatch({
          type: "prepared-run.retry",
          commandId: CommandId.make("command:changed-under-read:retry"),
          threadId,
          runId,
        });
        yield* goOn;
        yield* claims.tried;
        assert.equal(yield* probe.failCount, 0);
        yield* preparing;

        // Its new stretch of "preparing" counts from the next pass.
        yield* passesBeforeGrace(probe, preparing);
        assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.failed, runId);
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a launch that forks its preparation after its service stopped leaves no claim, so the check fails the run and Retry prepares it",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const hold = yield* makeLaunchHold;
      const claims = yield* makeClaimProbe;
      const harness = makeHarness({ claims: claims.layer });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { input, threadId, runId } = yield* orphanRun("stopped-service");
        const serviceScope = yield* Scope.make();
        const stopping = yield* Layer.buildWithScope(
          Layer.fresh(ThreadLaunch.layer).pipe(
            Layer.provide(
              Layer.merge(
                harness.launchDependencies,
                Layer.succeed(ThreadManagement.ThreadManagementService, hold.wrap(threads)),
              ),
            ),
          ),
          serviceScope,
        );
        yield* hold.arm;
        const launch = yield* Context.get(stopping, ThreadLaunch.ThreadLaunchService)
          .launch(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* hold.held;
        yield* Scope.close(serviceScope, Exit.void);
        yield* hold.resume;
        yield* Fiber.join(launch);

        yield* passesBeforeGrace(probe, Effect.void);
        assert.equal(yield* probe.pass, "read");
        const outcome = yield* Effect.raceFirst(
          probe.failed.pipe(Effect.as("failed")),
          claims.refused.pipe(Effect.as("claim still held")),
        );
        assert.equal(outcome, "failed");
        yield* launches.retryPreparation({
          commandId: CommandId.make("command:stopped-service:retry"),
          threadId,
          runId,
        });
        yield* released(threadId, "command:stopped-service:retry");
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a launch replay that marks a stuck run after the check found it unowned keeps the run",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const hold = yield* makeLaunchHold;
      const harness = makeHarness({ launchThreads: hold.wrap });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const { input, threadId, runId } = yield* orphanRun("replay-marks");
        yield* passesBeforeGrace(probe, Effect.void);
        const fail = yield* probe.holdBeforeFail;
        assert.equal(yield* probe.pass, "read");
        yield* fail.entered;
        // The replay takes its mark after the check's last look at the run's owners.
        yield* hold.arm;
        const replay = yield* launches
          .launch(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* hold.held;
        yield* fail.release;
        yield* probe.failAttempted;
        assert.equal(yield* runStatus(threadId, runId), "preparing");

        yield* hold.resume;
        yield* Fiber.join(replay);
        yield* released(threadId, "command:replay-marks");
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a fail the check decided for one stretch does not land on the next after a fail and a Retry",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const { threadId, runId } = yield* orphanRun("decided-earlier");
        const preparing = runStatus(threadId, runId).pipe(
          Effect.map((status) => assert.equal(status, "preparing")),
        );
        yield* passesBeforeGrace(probe, preparing);
        const fail = yield* probe.holdBeforeFail;
        assert.equal(yield* probe.pass, "read");
        yield* fail.entered;
        yield* failAndRetry(threadId, runId, "decided-earlier", 1);
        yield* fail.release;
        yield* probe.failAttempted;
        yield* preparing;
        assert.equal(yield* errorMessage(threadId, runId), "Cycle 1 failed.");

        yield* passesBeforeGrace(probe, preparing);
        assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.failed, runId);
        assert.equal(yield* errorMessage(threadId, runId), NOT_STARTED_MESSAGE);
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a fail the check decided for the second stretch does not land on the third after another fail and Retry",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const { threadId, runId } = yield* orphanRun("two-cycles");
        const preparing = runStatus(threadId, runId).pipe(
          Effect.map((status) => assert.equal(status, "preparing")),
        );
        yield* failAndRetry(threadId, runId, "two-cycles", 1);
        yield* passesBeforeGrace(probe, preparing);
        const fail = yield* probe.holdBeforeFail;
        assert.equal(yield* probe.pass, "read");
        yield* fail.entered;
        yield* failAndRetry(threadId, runId, "two-cycles", 2);
        yield* fail.release;
        yield* probe.failAttempted;
        yield* preparing;
        assert.equal(yield* errorMessage(threadId, runId), "Cycle 2 failed.");

        yield* passesBeforeGrace(probe, preparing);
        assert.equal(yield* probe.pass, "read");
        assert.equal(yield* probe.failed, runId);
        assert.equal(yield* errorMessage(threadId, runId), NOT_STARTED_MESSAGE);
      }).pipe(Effect.provide(withCheck(harness, probe)));
    }),
);

it.effect(
  "a run's claim keeps at most four preparations in line, and a fifth returns without preparing",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const claims = yield* PreparationClaims;
      const runId = RunId.make("run:claim-line");
      const holding = yield* Deferred.make<void>();
      const letGo = yield* Deferred.make<void>();
      const ran = yield* Ref.make(0);
      const holder = yield* claims
        .whileClaimed(
          runId,
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(letGo))),
          Effect.void,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(holding);
      const callers: Array<Fiber.Fiber<void>> = [];
      for (let caller = 1; caller <= 5; caller++)
        callers.push(
          yield* claims
            .whileClaimed(
              runId,
              Ref.update(ran, (count) => count + 1),
              Effect.void,
            )
            .pipe(Effect.forkChild({ startImmediately: true })),
        );
      yield* Deferred.succeed(letGo, undefined);
      yield* Fiber.join(holder);
      for (const caller of callers) yield* Fiber.join(caller);
      assert.equal(yield* Ref.get(ran), 4);
    }).pipe(Effect.provide(harness.layer));
  },
);
