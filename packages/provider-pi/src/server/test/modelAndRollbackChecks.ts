import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { PI_PROVIDER } from "../adapter.ts";
import type * as Fixture from "../adapter.test.ts";
import type * as FakePiModule from "./fakePi.ts";

export function registerPiModelAndRollbackChecks({
  makeFakePi,
  makeAdapter,
  openRuntime,
  startTurn,
  THREAD_ID,
  SESSION_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof FakePiModule.makeFakePi;
  makeAdapter: typeof Fixture.makeAdapter;
  openRuntime: typeof Fixture.openRuntime;
  startTurn: typeof Fixture.startTurn;
  THREAD_ID: typeof Fixture.THREAD_ID;
  SESSION_ID: typeof Fixture.SESSION_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect("selects the provider and id Pi reported when either contains a slash", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const hub = "hub=https://hub.example:8318/v1";
      fake.queueModels([{ provider: "openrouter", id: "openrouter/auto" }]);
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "First",
        modelSelection("openrouter/openrouter/auto"),
      );
      const openRouterRequest = yield* fake.takeRequest("set_model");
      assert.deepEqual(
        { provider: openRouterRequest["provider"], modelId: openRouterRequest["modelId"] },
        { provider: "openrouter", modelId: "openrouter/auto" },
      );
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");

      // A provider registered after the session started, e.g. by an extension reload.
      fake.queueModels([
        { provider: "openrouter", id: "openrouter/auto" },
        { provider: hub, id: "claude-haiku-4-5" },
      ]);
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Second",
        modelSelection(`${hub}/claude-haiku-4-5`),
        2,
      );
      const hubRequest = yield* fake.takeRequest("set_model");
      assert.deepEqual(
        { provider: hubRequest["provider"], modelId: hubRequest["modelId"] },
        { provider: hub, modelId: "claude-haiku-4-5" },
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("records the model Pi reports on the completed provider turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "model-b",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      });
      yield* fake.emit({ type: "agent_settled" });
      const turn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.equal(
        turn.type === "provider_turn.updated" ? turn.providerTurn.model : null,
        "anthropic/model-b",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rolls back a persisted thread on a fresh runtime after its session was released", () =>
    Effect.gen(function* () {
      const previousFake = yield* makeFakePi;
      const { runtime: previousRuntime } = yield* openRuntime(previousFake);
      const providerThread = yield* previousRuntime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const sessionFile = providerThread.nativeThreadRef?.nativeId;
      assert.isDefined(sessionFile);
      const turn = (ordinal: number, entryId: string): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId: entryId, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      const turns = [turn(1, "u1"), turn(2, "u2")];

      // Rollback opens the session the way CheckpointRollbackService does, without resumeThread.
      const fake = yield* makeFakePi;
      const adapter = yield* makeAdapter(fake);
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        initialNativeThreadId: sessionFile!,
      });
      yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
      fake.queueState({ sessionFile: sessionFile! });
      fake.queueState({ sessionFile: "/fake/rolled-back-session.jsonl" });
      const result = yield* runtime
        .rollbackThread({
          providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-1"),
            appRunOrdinal: 1,
            providerTurn: turns[0]!,
          },
          providerThreadTurns: turns,
        })
        .pipe(Effect.result);

      assert.equal(
        result._tag,
        "Success",
        `rollback on a fresh Pi runtime failed: ${result._tag === "Failure" ? String(result.failure.cause) : ""}`,
      );
      const requests = fake.allRequests();
      const switchIndex = requests.findIndex(
        (request) => request.type === "switch_session" && request.sessionPath === sessionFile,
      );
      const forkIndex = requests.findIndex((request) => request.type === "fork");
      assert.isAtLeast(switchIndex, 0, "fresh runtime never switched to the persisted session");
      assert.isAbove(forkIndex, switchIndex, "fork ran before switching to the persisted session");
      assert.equal(requests[forkIndex]?.entryId, "u2");
      if (result._tag !== "Success") return;
      assert.equal(
        result.success.providerThread.nativeThreadRef?.nativeId,
        "/fake/rolled-back-session.jsonl",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
