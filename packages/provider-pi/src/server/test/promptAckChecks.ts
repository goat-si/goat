import { assert, it } from "@effect/vitest";
import { RunId } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Fixture from "../adapter.test.ts";
import type * as FakePiModule from "./fakePi.ts";

const isProviderProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

/** Prompt ACK correlation (upstream f255158370): prompts carry ids, and a turn starts after the ACKs it would race. */
export function registerPiPromptAckChecks({
  makeFakePi,
  openRuntime,
  startTurn,
  THREAD_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof FakePiModule.makeFakePi;
  openRuntime: typeof Fixture.openRuntime;
  startTurn: typeof Fixture.startTurn;
  THREAD_ID: typeof Fixture.THREAD_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect.each([
    { first: "initial", accepted: true },
    { first: "steer", accepted: true },
    { first: "steer", accepted: false },
  ])(
    "waits for consumed input acknowledgments, first=$first accepted=$accepted",
    ({ first, accepted }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.deferNextLifecycle("prompt");
        yield* startTurn(runtime, providerThread);
        const initial = yield* fake.takeRequest("prompt");
        fake.deferNextLifecycle("prompt");
        const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
        assert.isTrue(running.type === "provider_turn.updated");
        if (running.type !== "provider_turn.updated") return;
        yield* runtime.steerTurn({
          threadId: THREAD_ID,
          runId: RunId.make("run:thread-pi-test:1"),
          providerThread,
          providerTurnId: running.providerTurn.id,
          message: {
            messageId: "message:handled-steer-first" as never,
            text: "Consumed steer",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });
        const steer = yield* fake.takeRequest("prompt");
        const stateRequests = fake
          .allRequests()
          .filter((request) => request["type"] === "get_state").length;
        yield* fake.emit({
          type: "response",
          id: (first === "steer" ? steer : initial)["id"],
          command: "prompt",
          success: accepted,
          data: { disposition: "handled" },
          error: accepted ? undefined : "Input refused",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "Steer acknowledged",
        });
        yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        assert.equal(runtime.providerSession.status, "running");
        assert.equal(
          fake.allRequests().filter((request) => request["type"] === "get_state").length,
          stateRequests,
        );
        yield* fake.emit({
          type: "response",
          id: (first === "steer" ? initial : steer)["id"],
          command: "prompt",
          success: true,
          data: { disposition: "handled" },
        });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { text: "/command-only", data: undefined, compacts: false },
    { text: "Plain handled input", data: { disposition: "handled" }, compacts: false },
    { text: "Handled input after compaction", data: { disposition: "handled" }, compacts: true },
  ])("settles consumed input after its ack: $text", ({ text, data, compacts }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      if (compacts) yield* fake.takeRequest("get_state");
      fake.deferNextLifecycle("prompt");
      yield* startTurn(runtime, providerThread, "default", [], text);
      yield* fake.takeRequest("prompt");
      if (compacts) {
        yield* fake.emit({ type: "compaction_start", reason: "manual" });
        yield* fake.emit({
          type: "compaction_end",
          reason: "manual",
          result: { summary: "Smaller context", tokensBefore: 1000, estimatedTokensAfter: 100 },
          aborted: false,
          willRetry: false,
        });
        yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "compaction" &&
            event.turnItem.status === "completed",
        );
        yield* fake.takeRequest("get_state");
      }
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-cmd",
        method: "notify",
        message: "Command finished\nwith details",
        notifyType: "info",
      });
      const notice = yield* takeEvent(
        (event) =>
          (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") ||
          event.type === "turn.terminal",
      );
      assert.isTrue(
        notice.type === "turn_item.updated" &&
          notice.turnItem.type === "system_notice" &&
          notice.turnItem.status === "completed" &&
          notice.turnItem.message === "Command finished\nwith details",
      );
      assert.equal(runtime.providerSession.status, "running");
      yield* fake.emit({ type: "response", command: "prompt", success: true, data });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["settled", "outer-id", "outer-idless", "install-id", "install-idless"])(
    "waits for a settled turn's late prompt ACK before accepting the next turn: %s",
    (boundary) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const interrupted = boundary !== "settled";
        const atInstall = boundary.startsWith("install-");
        // Suspend the next start before another turn acquires and releases ownership.
        if (atInstall) fake.deferNextModelSelection();
        let next = atInstall
          ? yield* startTurn(
              runtime,
              providerThread,
              "default",
              [],
              "Second turn",
              modelSelection("xai/grok-4.6"),
              2,
            ).pipe(Effect.result, Effect.forkScoped)
          : null;
        const modelRequest = atInstall ? yield* fake.takeRequest("set_model") : null;
        if (interrupted) fake.deferNextLifecycle("prompt");
        yield* startTurn(runtime, providerThread, "default", [], "/my-command");
        const firstPrompt = yield* fake.takeRequest("prompt");
        const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
        assert.isTrue(running.type === "provider_turn.updated");
        if (running.type !== "provider_turn.updated") return;
        if (interrupted) {
          const active = yield* startTurn(runtime, providerThread).pipe(Effect.result);
          assert.isTrue(
            active._tag === "Failure" &&
              isProviderProtocolError(active.failure.cause) &&
              active.failure.cause.reason === "previous_turn_active",
          );
          fake.deferNextLifecycle("prompt");
          yield* runtime.steerTurn({
            providerThread,
            providerTurnId: running.providerTurn.id,
            threadId: THREAD_ID,
            runId: RunId.make("run:thread-pi-test:1"),
            message: {
              messageId: "message:old-steer" as never,
              text: "Old steer",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          });
          yield* fake.takeRequest("prompt");
          yield* fake.emit({
            type: "extension_ui_request",
            id: "old-dialog",
            method: "confirm",
            title: "Old dialog",
          });
          yield* takeEvent(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
          yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
        } else {
          yield* fake.emit({ type: "agent_start" });
        }
        yield* fake.emit({ type: "agent_settled" });
        const firstTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          firstTerminal.type === "turn.terminal" &&
            firstTerminal.status === (interrupted ? "interrupted" : "completed"),
        );

        fake.deferNextLifecycle("prompt");
        if (next === null) {
          next = yield* startTurn(
            runtime,
            providerThread,
            "default",
            [],
            "Second turn",
            undefined,
            2,
          ).pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        }
        if (modelRequest !== null) {
          yield* fake.emit({
            type: "response",
            id: modelRequest["id"],
            command: "set_model",
            success: true,
            data: { provider: "xai", id: "grok-4.6" },
          });
        }
        if (interrupted) {
          yield* fake.emit({
            type: "extension_ui_request",
            id: "old-ack-barrier",
            method: "confirm",
            title: "Old input acknowledged",
          });
          const barrier = yield* takeEvent((event) => event.type === "runtime_request.updated");
          assert.isTrue(barrier.type === "runtime_request.updated");
          if (barrier.type !== "runtime_request.updated") return;
          yield* runtime.respondToRuntimeRequest({
            requestId: barrier.runtimeRequest.id,
            decision: "decline",
          });
          yield* fake.takeRequest("extension_ui_response");
          assert.isUndefined(next.pollUnsafe());
          assert.lengthOf(
            fake.allRequests().filter((request) => request["type"] === "prompt"),
            2,
          );
          yield* fake.emit({
            type: "response",
            command: "prompt",
            success: false,
            ...(boundary.endsWith("idless") ? {} : { id: firstPrompt["id"] }),
            error: "late command rejection",
          });
          // Duplicate and unknown IDs cannot consume the remaining old steer.
          for (const id of [firstPrompt["id"], "unknown-prompt"]) {
            yield* fake.emit({ type: "response", id, command: "prompt", success: true });
          }
          yield* fake.emit({
            type: "extension_ui_request",
            id: "partial-ack-barrier",
            method: "confirm",
            title: "Partial ACK",
          });
          const partial = yield* takeEvent(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
          assert.isTrue(partial.type === "runtime_request.updated");
          assert.isUndefined(next.pollUnsafe());
          assert.lengthOf(
            fake.allRequests().filter((request) => request["type"] === "prompt"),
            2,
          );
          yield* fake.emit({ type: "response", command: "prompt", success: true });
        }
        assert.equal((yield* Fiber.join(next))._tag, "Success");
        yield* fake.takeRequest("prompt");
        yield* fake.emit({
          type: "response",
          id: firstPrompt["id"],
          command: "prompt",
          success: false,
          error: "late command rejection",
        });
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        const secondTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          secondTerminal.type === "turn.terminal" && secondTerminal.status === "completed",
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { boundary: "outer", end: "session" },
    { boundary: "outer", end: "transport" },
    { boundary: "outer", end: "caller" },
    { boundary: "install", end: "session" },
    { boundary: "install", end: "transport" },
    { boundary: "install", end: "caller" },
  ])(
    "settles an ACK-blocked start on $end cancellation at $boundary admission",
    ({ boundary, end }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const runtimeScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
        const { runtime, takeEvent } = yield* openRuntime(fake).pipe(Scope.provide(runtimeScope));
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        if (boundary === "install") fake.deferNextModelSelection();
        let next =
          boundary === "install"
            ? yield* startTurn(
                runtime,
                providerThread,
                "default",
                [],
                "Second turn",
                modelSelection("xai/grok-4.6"),
                2,
              ).pipe(Effect.result, Effect.forkScoped({ startImmediately: true }))
            : null;
        const modelRequest = next === null ? null : yield* fake.takeRequest("set_model");
        fake.deferNextLifecycle("prompt");
        yield* startTurn(runtime, providerThread);
        const oldPrompt = yield* fake.takeRequest("prompt");
        const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
        assert.isTrue(running.type === "provider_turn.updated");
        if (running.type !== "provider_turn.updated") return;
        yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent((event) => event.type === "turn.terminal");
        if (next === null) {
          next = yield* startTurn(
            runtime,
            providerThread,
            "default",
            [],
            "Second turn",
            undefined,
            2,
          ).pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        }
        if (modelRequest !== null) {
          yield* fake.emit({
            type: "response",
            id: modelRequest["id"],
            command: "set_model",
            success: true,
            data: { provider: "xai", id: "grok-4.6" },
          });
        }
        yield* fake.emit({
          type: "extension_ui_request",
          id: "lifecycle-barrier",
          method: "confirm",
          title: "Pending ACK",
        });
        const dialog = yield* takeEvent(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        assert.isTrue(dialog.type === "runtime_request.updated");
        assert.isUndefined(next.pollUnsafe());
        assert.lengthOf(
          fake.allRequests().filter((request) => request["type"] === "prompt"),
          1,
        );
        if (end === "caller") {
          yield* Fiber.interrupt(next);
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(next)));
          const replacement = yield* startTurn(
            runtime,
            providerThread,
            "default",
            [],
            "Replacement",
            undefined,
            3,
          ).pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
          assert.isUndefined(replacement.pollUnsafe());
          assert.lengthOf(
            fake.allRequests().filter((request) => request["type"] === "prompt"),
            1,
          );
          yield* fake.emit({
            type: "response",
            id: oldPrompt["id"],
            command: "prompt",
            success: true,
          });
          assert.equal((yield* Fiber.join(replacement))._tag, "Success");
          yield* fake.takeRequest("prompt");
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({ type: "agent_settled" });
          const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
          assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
        } else {
          if (end === "session") yield* Scope.close(runtimeScope, Exit.void);
          else yield* fake.closeStdout;
          const failed = yield* Fiber.join(next);
          assert.isTrue(failed._tag === "Failure" && isProviderProtocolError(failed.failure.cause));
          yield* fake.emit({
            type: "response",
            id: oldPrompt["id"],
            command: "prompt",
            success: true,
          });
          assert.equal(
            (yield* startTurn(runtime, providerThread).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.lengthOf(
            fake.allRequests().filter((request) => request["type"] === "prompt"),
            1,
          );
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { handled: false, steer: "starts" },
    { handled: true, steer: "starts" },
    { handled: true, steer: "handled" },
    { handled: true, steer: "rejected" },
    { handled: true, steer: "compact-accepted" },
    { handled: true, steer: "compact-rejected" },
    { handled: false, steer: "compact-accepted" },
    { handled: false, steer: "compact-rejected" },
    { handled: true, steer: "compact-queued-accepted" },
    { handled: true, steer: "compact-queued-rejected" },
  ])("ignores stale idle probes, handled=$handled steer=$steer", ({ handled, steer }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      if (handled) fake.deferNextLifecycle("prompt");
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      if (!handled) yield* fake.emit({ type: "agent_start" });

      fake.deferNextState();
      yield* fake.emit(
        handled
          ? {
              type: "response",
              command: "prompt",
              success: true,
              data: { disposition: "handled" },
            }
          : { type: "agent_settled" },
      );
      yield* fake.takeRequest("get_state");
      const compact = steer.startsWith("compact-");
      fake.deferNextLifecycle("prompt");
      const steerInput = {
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:late-steer" as never,
          text: compact ? "/compact" : "Continue after settlement",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      } satisfies ProviderAdapter.ProviderAdapterV2SteerInput;
      yield* runtime.steerTurn(steerInput);
      const steeredPrompt = yield* fake.takeRequest(compact ? "compact" : "prompt");
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });
      if (compact) {
        if (steer.startsWith("compact-queued-")) {
          yield* runtime.steerTurn(steerInput);
          yield* fake.takeRequest("compact");
          // Put a current probe before a notice in the pump, independent of fork scheduling.
          for (const acknowledged of [false, true]) {
            if (acknowledged) {
              yield* fake.emit({ type: "response", command: "compact", success: true });
              yield* fake.takeRequest("get_state");
            }
            yield* fake.emit({
              type: "t3.settle_probe",
              providerTurnId,
              settleProbeGeneration: 2,
              data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
            });
            yield* fake.emit({
              type: "extension_ui_request",
              method: "notify",
              message: "Compact acknowledgment still pending",
            });
            const barrier = yield* takeEvent(
              (event) =>
                event.type === "turn.terminal" ||
                (event.type === "turn_item.updated" && event.turnItem.type === "system_notice"),
            );
            assert.equal(barrier.type, "turn_item.updated");
            assert.equal(runtime.providerSession.status, "running");
          }
        }
        yield* fake.emit({
          type: "response",
          command: "compact",
          success: !steer.endsWith("rejected"),
          error: "Compact refused",
        });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
        return;
      }
      if (steer !== "starts") {
        yield* fake.emit({
          type: "response",
          id: steeredPrompt["id"],
          command: "prompt",
          success: steer === "handled",
          data: { disposition: "handled" },
          error: steer === "rejected" ? "Input refused" : undefined,
        });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
        return;
      }

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Recovered" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered" }],
          stopReason: "stop",
        },
      });
      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.streaming === false,
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Recovered",
      );

      yield* fake.emit({
        type: "response",
        id: steeredPrompt["id"],
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
