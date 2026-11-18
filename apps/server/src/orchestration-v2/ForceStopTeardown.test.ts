import {
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { AgentScope } from "@goat/shared/AgentScope";
import type { ProviderAdapterV2SessionRuntime } from "@goat/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import {
  resumed,
  providerTurnId,
  stopTimedOut,
  turnInput,
} from "./Adapters/OpenCode2AdapterV2.fixtures.testkit.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:force-stop-teardown");
const providerSessionId = ProviderSessionId.make("provider-session:force-stop-teardown");
const providerThreadId = ProviderThreadId.make("provider-thread:force-stop-teardown");
const stoppedRunId = RunId.make("run:force-stop-teardown:stopped");

const harness = (input: {
  readonly others: ReadonlyArray<string>;
  readonly newerRunAfterSettle?: boolean;
  readonly cancelledFollowUp?: boolean;
  readonly cloud?: boolean;
  readonly openCode?: {
    readonly ownsProcess?: boolean;
    readonly live?: boolean;
    readonly runtime?: ProviderAdapterV2SessionRuntime;
  };
}) => {
  const calls: Array<string> = [];
  const sessionId = input.openCode?.runtime?.providerSessionId ?? providerSessionId;
  const providerThread = {
    id: providerThreadId,
    appThreadId: threadId,
    providerSessionId: sessionId,
    driver: ProviderDriverKind.make(input.openCode ? "opencode" : "codex"),
    ...(input.cloud ? { cloudTask: {} } : {}),
  };
  const stopped = {
    id: stoppedRunId,
    ordinal: 1,
    startedAt: "t",
    activeAttemptId: "attempt",
    providerThreadId,
  };
  // A follow-up queued behind the stopped run and cancelled before it ever started.
  const cancelled = {
    id: RunId.make("run:cancelled"),
    ordinal: 2,
    status: "cancelled",
    startedAt: null,
  };
  let runs: Array<unknown> = [
    { ...stopped, status: "running" },
    ...(input.cancelledFollowUp ? [cancelled] : []),
  ];
  const records = () =>
    ({
      thread: { id: threadId, deletedAt: null },
      runs,
      providerThreads: [providerThread],
      providerTurns: [
        {
          id: "provider-turn:stopped",
          providerThreadId,
          runAttemptId: "attempt",
          status: "running",
        },
      ],
    }) as unknown as OrchestrationV2ThreadProjection;
  const layer = ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: () =>
          Effect.succeed(
            input.openCode?.live === false
              ? Option.none()
              : Option.some(
                  input.openCode?.runtime ??
                    ({
                      providerSession: {
                        capabilities: { sessions: { ownsProcess: input.openCode?.ownsProcess } },
                      },
                    } as unknown as ProviderAdapterV2SessionRuntime),
                ),
          ),
        isLive: () => Effect.succeed(true),
        otherWorkingThreads: () => Effect.succeed(input.others.map((id) => ThreadId.make(id))),
        releaseUnlessBusy: (release) =>
          Effect.sync(() => calls.push("release:run-" + String(release.runOrdinal))).pipe(
            Effect.as(true),
          ),
        detach: () => Effect.sync(() => calls.push("detach")),
      }),
    ),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () => Effect.sync(records),
        dispatch: (command: OrchestrationV2ServerCommand) =>
          Effect.sync(() => {
            calls.push(command.type);
            // The settlement frees the thread, and a new message starts run 2 before cleanup.
            if (input.newerRunAfterSettle)
              runs = [
                { ...stopped, status: "interrupted" },
                { id: RunId.make("run:force-stop-teardown:newer"), ordinal: 2, status: "running" },
              ];
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(AgentScope, {
        ...AgentScope.defaultValue(),
        kill: () => Effect.sync(() => calls.push("kill")).pipe(Effect.as(false)),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );
  const forceStop = ThreadManagementService.ThreadManagementService.use((service) =>
    service.forceStopThread({ threadId, runId: stoppedRunId }),
  ).pipe(Effect.provide(layer));
  return { calls, forceStop };
};

it.effect.each([
  {
    path: "release",
    others: [] as ReadonlyArray<string>,
    newer: false,
    teardown: ["release:run-1"],
  },
  { path: "release", others: [] as ReadonlyArray<string>, newer: true, teardown: [] },
  { path: "shared detach", others: ["thread:sibling"], newer: false, teardown: ["detach"] },
  { path: "shared detach", others: ["thread:sibling"], newer: true, teardown: [] },
])(
  "Force stop's $path teardown is bound to the stopped run (newer run admitted: $newer)",
  ({ others, newer, teardown }) =>
    Effect.gen(function* () {
      const { calls, forceStop } = harness({ others, newerRunAfterSettle: newer });
      const result = yield* forceStop;
      expect(calls).toEqual(["kill", "thread.background-work.settle", ...teardown]);
      if (newer) expect(result).toEqual({ outcome: "shared", sharedWithThreadIds: [] });
    }),
);

it.effect.each([
  {
    path: "release",
    others: [] as ReadonlyArray<string>,
    teardown: ["release:run-1"],
    result: { outcome: "released", sharedWithThreadIds: [] },
  },
  {
    path: "shared detach",
    others: ["thread:sibling"],
    teardown: ["detach"],
    result: { outcome: "shared", sharedWithThreadIds: ["thread:sibling"] },
  },
])(
  "Force stop still runs its $path teardown when a queued follow-up was cancelled before starting",
  ({ others, teardown, result }) =>
    Effect.gen(function* () {
      const { calls, forceStop } = harness({ others, cancelledFollowUp: true });
      expect(yield* forceStop).toEqual(result);
      expect(calls).toEqual(["kill", "thread.background-work.settle", ...teardown]);
    }),
);

it.effect("Force stop refuses a cloud agent and leaves its session and tracking alone", () =>
  Effect.gen(function* () {
    const { calls, forceStop } = harness({ others: [], cloud: true });
    const error = yield* Effect.flip(forceStop);
    expect(error).toMatchObject({ _tag: "OrchestrationV2ForceStopThreadError", reason: "cloud" });
    expect(error.message).toBe("Cloud agents stop through their provider, not Force stop.");
    expect(calls).toEqual([]);
  }),
);

it.effect.each([
  { name: "external", openCode: { ownsProcess: false } },
  { name: "legacy with unknown ownership", openCode: {} },
  { name: "no longer live", openCode: { ownsProcess: true, live: false } },
])("Force stop refuses an OpenCode session that is $name before touching the run", ({ openCode }) =>
  Effect.gen(function* () {
    const { calls, forceStop } = harness({ others: [], openCode });
    expect(yield* Effect.result(forceStop)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OrchestrationV2ForceStopThreadError" },
    });
    expect(calls).toEqual([]);
  }),
);

it.effect("Force stop still settles a run on a GOAT-owned OpenCode session", () =>
  Effect.gen(function* () {
    const { calls, forceStop } = harness({ others: [], openCode: { ownsProcess: true } });
    expect(yield* forceStop).toEqual({ outcome: "released", sharedWithThreadIds: [] });
    expect(calls).toEqual(["kill", "thread.background-work.settle", "release:run-1"]);
  }),
);

it.effect("Force stop refuses a managed OpenCode 2 borrow after its native Stop times out", () =>
  Effect.gen(function* () {
    const borrowers = { current: 0 };
    const { runtime, thread } = yield* resumed(stopTimedOut, { external: false, borrowers });
    yield* runtime.startTurn(turnInput(thread));
    const stopping = yield* runtime
      .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
      .pipe(Effect.result, Effect.forkScoped);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(stopping)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderAdapterInterruptTimeoutError" },
    });
    const { calls, forceStop } = harness({ others: [], openCode: { runtime } });
    expect(yield* Effect.result(forceStop)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OrchestrationV2ForceStopThreadError" },
    });
    expect(calls).toEqual([]);
    expect(borrowers.current).toBe(1);
    expect(runtime.providerSession.capabilities.sessions.ownsProcess).toBe(false);
  }).pipe(Effect.provide(McpProviderSessions.layer), Effect.scoped),
);
