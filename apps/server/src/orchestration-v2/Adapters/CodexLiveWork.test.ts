import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ProviderThread } from "@goat/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

import { makeCodexLiveWork } from "./CodexLiveWork.ts";

interface Turn {
  readonly nativeTurnId: string;
  readonly providerThread: { readonly id: string };
  readonly subagent: { readonly parentContext: Turn } | null;
}

type GoalRead = "active" | "paused" | "fails";

const makeState = () => ({
  activeTurns: new Map<string, Turn>(),
  pendingRuntimeRequests: new Map<string, unknown>(),
  pendingSubagentTurns: new Map<string, unknown>(),
  subagentThreads: new Map<string, { task: { status: string }; parentContext: Turn }>(),
  goalsByNativeThread: new Map<string, { status: string } | null>(),
  waiting: new Map<string, unknown>(),
  pendingGoalThreads: new Set<string>(),
  goalReads: [] as Array<string>,
  goalRead: "active" as GoalRead,
});
type State = ReturnType<typeof makeState>;

const rootTurn: Turn = {
  nativeTurnId: "turn-root",
  providerThread: { id: "provider-thread-root" },
  subagent: null,
};

const liveWork = (state: State) =>
  makeCodexLiveWork<Turn>({
    client: {
      request: (_method: string, params: { readonly threadId: string }) =>
        Effect.suspend(() => {
          state.goalReads.push(params.threadId);
          return state.goalRead === "fails"
            ? Effect.fail(CodexErrors.CodexAppServerRequestError.internalError("goal read failed"))
            : Effect.succeed({ goal: { status: state.goalRead } });
        }),
    } as unknown as CodexClient.CodexAppServerClient["Service"],
    activeTurns: Effect.sync(() => state.activeTurns),
    settledTurns: Effect.succeed(new Map()),
    runningCommandItems: Effect.succeed(new Map()),
    runningDynamicTools: Effect.succeed(new Map()),
    pendingMcpAppCaptures: Effect.succeed(new Map()),
    imageTurns: new Map(),
    subagentThreads: Effect.sync(() => state.subagentThreads),
    pendingSubagentTurns: Effect.sync(() => state.pendingSubagentTurns),
    pendingRuntimeRequests: Effect.sync(() => state.pendingRuntimeRequests),
    goalsByNativeThread: state.goalsByNativeThread,
    survivors: { waiting: state.waiting, pendingGoalThreads: state.pendingGoalThreads },
    turnHasRetainedBackgroundWork: () => Effect.succeed(false),
  });

const providerThread = (nativeId: string) =>
  ({
    id: `provider-thread-${nativeId}`,
    nativeThreadRef: { nativeId },
  }) as OrchestrationV2ProviderThread;

const holds: ReadonlyArray<{
  readonly work: string;
  readonly start: (state: State) => void;
  readonly settle: (state: State) => void;
}> = [
  {
    work: "a running native turn",
    start: (state) => state.activeTurns.set("turn-root", rootTurn),
    settle: (state) => state.activeTurns.delete("turn-root"),
  },
  {
    work: "a pending approval",
    start: (state) => state.pendingRuntimeRequests.set("request", {}),
    settle: (state) => state.pendingRuntimeRequests.delete("request"),
  },
  {
    work: "a waiting survivor",
    start: (state) => state.waiting.set("native-survivor", {}),
    settle: (state) => state.waiting.delete("native-survivor"),
  },
  {
    work: "an active goal",
    start: (state) => state.goalsByNativeThread.set("native-goal", { status: "active" }),
    settle: (state) => state.goalsByNativeThread.set("native-goal", { status: "paused" }),
  },
  {
    work: "a goal block this session still fences",
    start: (state) => state.pendingGoalThreads.add("native-goal"),
    settle: (state) => state.pendingGoalThreads.delete("native-goal"),
  },
  {
    work: "a pending native subagent",
    start: (state) =>
      state.subagentThreads.set("child", { task: { status: "pending" }, parentContext: rootTurn }),
    settle: (state) =>
      state.subagentThreads.set("child", {
        task: { status: "completed" },
        parentContext: rootTurn,
      }),
  },
  {
    work: "a subagent turn waiting for its thread",
    start: (state) => state.pendingSubagentTurns.set("child", []),
    settle: (state) => state.pendingSubagentTurns.delete("child"),
  },
];

it.effect.each(holds)("$work holds the session until it settles", ({ start, settle }) =>
  Effect.gen(function* () {
    const state = makeState();
    const { holdsLiveWork } = liveWork(state);
    assert.isFalse(yield* holdsLiveWork({ pastPinCeiling: false }));
    start(state);
    assert.isTrue(yield* holdsLiveWork({ pastPinCeiling: false }));
    settle(state);
    assert.isFalse(yield* holdsLiveWork({ pastPinCeiling: false }));
  }),
);

it.effect.each([
  { read: "active", held: true },
  { read: "paused", held: false },
  { read: "fails", held: true },
] as const)("past the ceiling an active goal is confirmed: $read -> held=$held", ({ read, held }) =>
  Effect.gen(function* () {
    const state = makeState();
    state.goalsByNativeThread.set("native-goal", { status: "active" });
    state.goalRead = read;
    const { holdsLiveWork } = liveWork(state);
    assert.isTrue(yield* holdsLiveWork({ pastPinCeiling: false }));
    assert.deepEqual(state.goalReads, []);
    assert.strictEqual(yield* holdsLiveWork({ pastPinCeiling: true }), held);
    assert.deepEqual(state.goalReads, ["native-goal"]);
  }),
);

it.effect("a goal-active or survivor thread is kept loaded, other threads are not", () =>
  Effect.gen(function* () {
    const state = makeState();
    state.goalsByNativeThread.set("native-goal", { status: "active" });
    state.waiting.set("native-survivor", {});
    const { hasPendingBackgroundWorkForThread } = liveWork(state);
    assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThread("native-goal")));
    assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThread("native-survivor")));
    assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThread("native-idle")));
  }),
);
