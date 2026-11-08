import { CodexSettings, ProviderSessionId, ThreadId } from "@goat/contracts";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeReplayServerConfig,
  withCodexReplayChildMetadata,
} from "./CodexAdapterV2.testkit.ts";
import {
  codexReplayPreamble as baseCodexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
} from "./CodexReplay.testkit.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

export function codexReplayPreamble(
  input: Parameters<typeof baseCodexReplayPreamble>[0] & { readonly effort?: string },
) {
  return baseCodexReplayPreamble(input).map((entry) =>
    entry.type === "expect_outbound" &&
    Predicate.isObject(entry.frame) &&
    entry.frame.method === "turn/start" &&
    Predicate.isObject(entry.frame.params)
      ? {
          ...entry,
          frame: {
            ...entry.frame,
            params: {
              ...entry.frame.params,
              ...(input.effort === undefined ? {} : { effort: input.effort }),
              collaborationMode: {
                mode: "default",
                settings: {
                  model: "gpt-5.4",
                  ...(input.effort === undefined ? {} : { reasoning_effort: input.effort }),
                },
              },
            },
          },
        }
      : entry,
  );
}

export const makeCodexReplayHarness = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown> = () =>
    Effect.void,
  onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
  readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
  beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
  observeSleeps = false,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const listeners = new Set<() => void>();
    const signalChange = () => {
      for (const listener of listeners) listener();
    };
    const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
      Effect.callback<void>((resume) => {
        const check = () => {
          if (!predicate()) return;
          listeners.delete(check);
          resume(Effect.void);
        };
        // Subscribe before checking so an already-observed event also satisfies
        // the wait, without a gap in which a new event could be missed.
        listeners.add(check);
        check();
        return Effect.sync(() => {
          listeners.delete(check);
        });
      }).pipe(Effect.withSpan(label));
    const processedPlanDeltas = new Set<string>();
    const startedSleeps = new Map<number, number>();
    const clock = yield* Clock.Clock;
    const observedClock: Clock.Clock = {
      ...clock,
      sleep: (duration) =>
        Effect.gen(function* () {
          // Start the real TestClock sleep through its suspension before
          // acknowledging it; clock advancement cannot race registration.
          const timer = yield* clock
            .sleep(duration)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const millis = Duration.toMillis(duration);
          startedSleeps.set(millis, (startedSleeps.get(millis) ?? 0) + 1);
          signalChange();
          yield* Fiber.join(timer);
        }),
    };
    let processEnvironment: NodeJS.ProcessEnv = {};
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) =>
        Effect.gen(function* () {
          processEnvironment = openInput.environment;
          const driver = yield* CodexReplay.makeReplayDriver(
            transcript,
            beforeEmitInbound ? { beforeEmitInbound } : {},
          );
          const client = Layer.build(CodexReplay.layerReplayWithDriver(driver));
          return yield* observeSleeps
            ? client.pipe(Effect.provideService(Clock.Clock, observedClock))
            : client;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.map((client) =>
                withCodexReplayChildMetadata(client, transcript, readChildMetadata),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    handleServerNotification: (method, handler) =>
                      client.handleServerNotification(method, (payload) =>
                        handler(payload).pipe(
                          Effect.andThen(
                            Effect.sync(() => {
                              if (
                                method === "item/plan/delta" &&
                                Predicate.isObject(payload) &&
                                "delta" in payload &&
                                typeof payload.delta === "string"
                              ) {
                                processedPlanDeltas.add(payload.delta);
                                signalChange();
                              }
                            }),
                          ),
                        ),
                      ),
                    request: (method, params) =>
                      onRequest(method, params).pipe(
                        Effect.andThen(client.request(method, params)),
                      ),
                    // Reconfiguring resumes go through the raw protocol.
                    raw: {
                      ...client.raw,
                      request: (method, params) =>
                        onRequest(method, params).pipe(
                          Effect.andThen(client.raw.request(method, params)),
                        ),
                    },
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.provide(context),
            ),
          ),
        ),
    };
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory,
      crypto: yield* Crypto.Crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
            signalChange();
          }),
      },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const firstTerminal = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
          signalChange();
        }).pipe(
          Effect.andThen(
            event.type === "turn.terminal"
              ? Deferred.succeed(firstTerminal, undefined)
              : Effect.void,
          ),
          Effect.andThen(onEvent(event)),
        ),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    const subagentUpdates = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
          event.type === "subagent.updated",
      );
    return {
      runtime,
      processEnvironment,
      providerThread,
      threadId,
      serverConfig,
      events,
      continuationRequests,
      terminalEvents,
      subagentUpdates,
      hasPendingBackgroundWork,
      awaitUntil,
      awaitPlanDelta: (delta: string) =>
        awaitUntil(() => processedPlanDeltas.has(delta), "plan delta processed"),
      awaitSleep: (millis: number, count = 1) =>
        awaitUntil(
          () => (startedSleeps.get(millis) ?? 0) >= count,
          `${millis} ms timer registered`,
        ),
      consumerBarrier: awaitUntil(
        () =>
          events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.objective === "Test event consumer barrier",
          ),
        "event consumer barrier",
      ),
      firstTerminal: Deferred.await(firstTerminal),
    };
  });

export const RESUME_SCENARIO = "codex-resume-subagent";
export const RESUME_NATIVE_THREAD = "native-codex-resume-thread";
export const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";
export const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";
export const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";
const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";
export const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

export const childAgentMessage = (input: {
  readonly id: string;
  readonly text: string;
  readonly turnId: string;
  readonly completedAtMs: number;
  readonly afterMs?: number;
  readonly omitPhase?: boolean;
}): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `item/completed/${input.id}`,
  ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
  frame: {
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        id: input.id,
        text: input.text,
        ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
        memoryCitation: null,
      },
      threadId: RESUME_CHILD_THREAD,
      turnId: input.turnId,
      completedAtMs: input.completedAtMs,
    },
  },
});

const childTurnStarted = (
  turnId: string,
  afterMs?: number,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `turn/started/${turnId}`,
  ...(afterMs === undefined ? {} : { afterMs }),
  frame: {
    method: "turn/started",
    params: {
      threadId: RESUME_CHILD_THREAD,
      turn: {
        ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
        startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
      },
    },
  },
});

export const childTurnCompleted = (
  turnId: string,
  afterMs?: number,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `turn/completed/${turnId}`,
  ...(afterMs === undefined ? {} : { afterMs }),
  frame: {
    method: "turn/completed",
    params: {
      threadId: RESUME_CHILD_THREAD,
      turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
    },
  },
});

export const resumeSubagentTranscript = makeCodexReplayTranscript({
  scenario: RESUME_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: RESUME_NATIVE_THREAD,
      nativeTurnId: RESUME_NATIVE_TURN,
      prompt: RESUME_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/completed/subAgentActivity-started",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: "call-codex-resume-spawn",
            kind: "started",
            agentThreadId: RESUME_CHILD_THREAD,
            agentPath: "/root/resume_agent",
          },
          threadId: RESUME_NATIVE_THREAD,
          turnId: RESUME_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    childTurnStarted(RESUME_CHILD_TURN_1),
    childAgentMessage({
      id: "child-first-answer",
      text: "CODEX_FIRST_DONE",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442000,
    }),
    childAgentMessage({
      id: "child-first-answer-empty",
      text: "",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442001,
      omitPhase: true,
    }),
    childAgentMessage({
      id: "child-first-answer-duplicate",
      text: "CODEX_FIRST_DONE",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442002,
    }),
    childTurnCompleted(RESUME_CHILD_TURN_1, 100),
    {
      type: "emit_inbound",
      label: "item/completed/root-answer",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "root-answer-resume",
            text: "NUDGED",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: RESUME_NATIVE_THREAD,
          turnId: RESUME_NATIVE_TURN,
          completedAtMs: 1782622443000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/root",
      frame: {
        method: "turn/completed",
        params: {
          threadId: RESUME_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
    childAgentMessage({
      id: "child-resume-answer",
      text: "CODEX_RESUME_DONE",
      turnId: RESUME_CHILD_TURN_2,
      completedAtMs: 1782622480000,
      afterMs: 30_000,
    }),
    childTurnCompleted(RESUME_CHILD_TURN_2),
  ],
});

export const lateChildPrefix = () => {
  const entries = resumeSubagentTranscript.entries;
  const labelIndex = (label: string) =>
    entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === label);
  const rootCompleted = labelIndex("turn/completed/root");
  return {
    spawned: entries.slice(0, labelIndex(`turn/started/${RESUME_CHILD_TURN_1}`) + 1),
    rootFinished: entries.slice(rootCompleted - 1, rootCompleted + 1),
  };
};
