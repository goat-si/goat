import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  ProviderDriverKind,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { OMO_PROFILE } from "./profile.ts";
import type * as Fixture from "./adapter.test.ts";
import type * as FakePiModule from "./test/fakePi.ts";

// OmO pages history; a page that claims more without a cursor cannot advance.
const STUCK_PAGE = { entries: [], leafId: null, hasMore: true };

export function registerOmoAdapterChecks({
  makeFakePi,
  openRuntime,
  startTurn,
  THREAD_ID,
  SESSION_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof FakePiModule.makeFakePi;
  openRuntime: typeof Fixture.openRuntime;
  startTurn: typeof Fixture.startTurn;
  THREAD_ID: typeof Fixture.THREAD_ID;
  SESSION_ID: typeof Fixture.SESSION_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect("keeps an OmO extension status published before computer control is disabled", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "watch",
        statusText: "Ready",
      });
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" &&
          event.providerSession.extensionStatuses?.some((status) => status.key === "watch") ===
            true,
      );
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      assert.deepEqual(runtime.providerSession.extensionStatuses, [
        { key: "watch", text: "Ready" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rejects an invalid OmO history page during resume", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueEntries({ entries: [], leafId: null, hasMore: true });
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.match(String(error.cause), /Page cannot advance/);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("disables OmO computer control when starting and switching sessions", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* runtime.resumeThread({ providerThread });
      fake.vetoNextSwitch();
      yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: { ...providerThread, nativeThreadRef: null },
      });
      const requests = fake.allRequests();
      const commands = requests.flatMap((request, index) =>
        request.type === "prompt" && request.message === "/computer off" ? [index] : [],
      );
      assert.lengthOf(commands, 3);
      for (const type of ["switch_session", "new_session"]) {
        const index = requests.findIndex((request) => request.type === type);
        assert.equal(requests[index + 1]?.message, "/computer off");
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("still ends an OmO turn when its history cannot be read at completion", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      fake.queueEntries(STUCK_PAGE);
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const ended = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.isTrue(ended.type === "provider_turn.updated");
      yield* takeEvent((event) => event.type === "turn.terminal");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops the OmO process even when its history cannot be read first", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      if (running.type !== "provider_turn.updated") return;
      fake.queueEntries(STUCK_PAGE);
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: running.providerTurn.id,
        requestRuntimeRestart: true,
      });
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "stopped",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("drops the old OmO session binding when /computer off fails after a fork", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number, entryId: string): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: {
          driver: ProviderDriverKind.make("omo"),
          nativeId: entryId,
          strength: "strong",
        },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      const first = turn(1, "u1");
      const turns = [first, turn(2, "u2")];
      fake.failNextPrompt();
      yield* runtime
        .rollbackThread({
          providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-1"),
            appRunOrdinal: 1,
            providerTurn: first,
          },
          providerThreadTurns: turns,
        })
        .pipe(Effect.flip);
      assert.isTrue(fake.allRequests().some((request) => request.type === "fork"));
      yield* startTurn(runtime, providerThread, "default", [], "After rollback", undefined, 2).pipe(
        Effect.flip,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
