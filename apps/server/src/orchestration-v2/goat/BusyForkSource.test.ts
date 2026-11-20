import {
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  ProviderTurnId,
  RunId,
} from "@goat/contracts";
import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { ensureSafeNativeFork } from "./BusyForkSource.ts";

it.effect("execution rechecks capability and completed source boundary after planning", () =>
  Effect.gen(function* () {
    const thread = { id: ProviderThreadId.make("source") } as OrchestrationV2ProviderThread;
    const boundary = {
      id: RunId.make("boundary"),
      status: "completed",
      activeAttemptId: null,
    } as OrchestrationV2Run;
    const running = { id: RunId.make("running"), status: "running" } as OrchestrationV2Run;
    const source = {
      runs: [boundary, running],
      attempts: [],
      providerTurns: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const session = {
      driver: "claudeAgent",
      providerSession: { capabilities: ClaudeProviderCapabilitiesV2 },
      providerInstanceId: ProviderInstanceId.make("claude"),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    assert.equal(
      (yield* Effect.result(ensureSafeNativeFork(source, boundary, session, thread)))._tag,
      "Failure",
    );
    const attemptId = RunAttemptId.make("source-attempt");
    const turnId = ProviderTurnId.make("source-turn");
    const completed = { ...boundary, activeAttemptId: attemptId };
    const withTurn = {
      ...source,
      attempts: [{ id: attemptId, providerTurnId: turnId }],
      providerTurns: [
        {
          id: turnId,
          runAttemptId: attemptId,
          status: "completed",
          ordinal: 1,
          providerThreadId: thread.id,
          nativeTurnRef: { driver: "claudeAgent", nativeId: "boundary-message", strength: "weak" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.equal(
      (yield* Effect.result(ensureSafeNativeFork(withTurn, completed, session, thread)))._tag,
      "Success",
    );
    const unsupported = {
      ...session,
      providerSession: {
        ...session.providerSession,
        capabilities: {
          ...session.providerSession.capabilities,
          threads: {
            ...session.providerSession.capabilities.threads,
            canForkWhileSourceRunning: false,
          },
        },
      },
    };
    assert.equal(
      (yield* Effect.result(ensureSafeNativeFork(withTurn, completed, unsupported, thread)))._tag,
      "Failure",
    );
    const rolledBack = { ...boundary, status: "rolled_back" as const };
    assert.equal(
      (yield* Effect.result(
        ensureSafeNativeFork({ ...source, runs: [rolledBack] }, rolledBack, session, thread),
      ))._tag,
      "Failure",
    );
  }),
);
