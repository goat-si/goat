import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

export const makeBackgroundStopAdapter = ({
  cwd,
  events,
  started,
  interrupts,
  failedStart,
  backgroundWorkAfterStop,
}: {
  readonly cwd: string;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  readonly started: ProviderAdapter.ProviderAdapterV2TurnInput[];
  readonly interrupts: ProviderAdapter.ProviderAdapterV2InterruptInput[];
  readonly failedStart: boolean;
  readonly backgroundWorkAfterStop: "running" | "unknown" | undefined;
}): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd,
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ...(failedStart
          ? {
              hasPendingBackgroundWorkForThread: (providerThread) =>
                Effect.gen(function* () {
                  if (!interrupts.some((input) => input.providerThread.id === providerThread.id)) {
                    return false;
                  }
                  if (backgroundWorkAfterStop === "unknown") {
                    return yield* Effect.die("Background work probe failed");
                  }
                  return backgroundWorkAfterStop === "running";
                }),
            }
          : {}),
        ensureThread: ({ threadId }) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turn) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${turn.attemptId}`,
                  strength: "strong",
                },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            });
          }),
        steerTurn: () => Effect.die("unused"),
        interruptTurn: (interrupt) =>
          Effect.sync(() => {
            interrupts.push(interrupt);
          }),
        respondToRuntimeRequest: () => Effect.die("unused"),
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
    }),
});
