import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FleetSettings,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Fallback from "../fleet/resources/Fallback.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const candidate = (id: string): ProjectionStore.ProjectionLimitRecoveryCandidate => ({
  id: ThreadId.make(id),
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: "2026-10-20T05:00:00.000Z",
  latestRunId: RunId.make("run:" + id),
  latestRunCompletedAt: DateTime.makeUnsafe(NOW - 1000),
  updatedAt: DateTime.makeUnsafe(NOW - 1000),
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  limitRecovery: null,
  snoozedUntil: null,
});

/** Builds the worker, runs one sweep, and reports what it asked for and dispatched. */
const sweep = (options: {
  readonly autoResume: boolean;
  readonly coversThreads: boolean;
  readonly switched: ReadonlySet<string>;
  readonly goalThreads?: ReadonlySet<string>;
  readonly candidates?: ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>;
  readonly fleet?: FleetSettings;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const queried: Array<string> = [];
    const asked: Array<string> = [];
    const commands: Array<OrchestrationV2ServerCommand> = [];
    let registered: Effect.Effect<void> | undefined;
    yield* Layer.build(
      UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mock(Scheduler.Scheduler)({
            register: <E, R>(_name: string, runDueWork: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                registered = runDueWork.pipe(Effect.provideContext(context), Effect.orDie);
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: (input) =>
              Effect.sync(() => {
                queried.push(
                  "autoResume=" +
                    input.autoResume +
                    " triggers=" +
                    input.fallbackTriggers?.join(","),
                );
                return options.candidates ?? [candidate("a"), candidate("b"), candidate("goal")];
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            autoArmLimitRecovery: (input) =>
              Effect.sync(() => {
                commands.push({ type: "thread.metadata.update", ...input });
                return { sequence: commands.length } as never;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length } as never;
              }),
          }),
        ),
        Layer.provide(
          ServerSettings.ServerSettingsService.layerTest({
            autoResumeLimitedThreads: options.autoResume,
            fleet: options.fleet ?? {
              fallbackChains: {
                default: {
                  scope: "goals_and_threads",
                  steps: [{ instanceId: ProviderInstanceId.make("codex"), model: "a" }],
                },
              },
            },
          }),
        ),
        Layer.provide(
          Layer.succeed(Fallback.GoalThreadOwnership, {
            isGoalThread: (threadId) => Effect.succeed(options.goalThreads?.has(threadId) === true),
          }),
        ),
        Layer.provide(
          Layer.mock(Fallback.Fallback)({
            coversThreads: Effect.succeed(options.coversThreads),
            continueThread: (threadId) =>
              Effect.sync(() => {
                asked.push(threadId);
                return options.switched.has(threadId);
              }),
          }),
        ),
      ),
    );
    yield* registered!;
    return {
      queried,
      asked,
      armed: commands.map((command): string => ("threadId" in command ? command.threadId : "")),
    };
  }).pipe(Effect.scoped);

describe("UsageLimitRecoveryWorker fallback branch", () => {
  it.effect("reconsiders an armed run before dispatching its due timed resume", () =>
    Effect.gen(function* () {
      const armed = candidate("a");
      const result = yield* sweep({
        autoResume: true,
        coversThreads: true,
        switched: new Set(["a"]),
        candidates: [
          {
            ...armed,
            usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
            limitRecovery: {
              runId: armed.latestRunId!,
              resetAt: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
              autoResume: true,
            },
          },
        ],
      });
      assert.deepEqual(result.asked, ["a"]);
      assert.deepEqual(result.armed, []);
    }),
  );
  it.effect("switches a covered thread instead of arming its reset, and arms the rest", () =>
    Effect.gen(function* () {
      const result = yield* sweep({
        autoResume: true,
        coversThreads: true,
        switched: new Set(["a"]),
        goalThreads: new Set(["goal"]),
      });
      assert.deepStrictEqual(result, {
        queried: ["autoResume=true triggers=usage_limit"],
        asked: ["a", "b"],
        armed: ["b"],
      });
    }),
  );

  it.effect(
    "looks for unarmed failures for a thread chain even with auto-resume off, arming none",
    () =>
      Effect.gen(function* () {
        const result = yield* sweep({
          autoResume: false,
          coversThreads: true,
          switched: new Set(),
        });
        assert.deepStrictEqual(result, {
          queried: ["autoResume=false triggers=usage_limit"],
          asked: ["a", "b", "goal"],
          armed: [],
        });
      }),
  );

  it.effect("behaves exactly as before without a thread chain", () =>
    Effect.gen(function* () {
      const result = yield* sweep({
        autoResume: true,
        coversThreads: false,
        switched: new Set(["a"]),
      });
      assert.deepStrictEqual(result, {
        queried: ["autoResume=true triggers="],
        asked: [],
        armed: ["a", "b", "goal"],
      });
      const off = yield* sweep({ autoResume: false, coversThreads: false, switched: new Set() });
      assert.deepStrictEqual(off.queried, ["autoResume=false triggers="]);
    }),
  );
});
