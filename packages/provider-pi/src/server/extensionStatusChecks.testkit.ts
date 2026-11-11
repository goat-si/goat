import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import type * as Fixture from "./adapter.test.ts";
import type * as FakePiModule from "./test/fakePi.ts";

export function registerPiExtensionStatusChecks({
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
  it.effect(
    "replaces keyed extension statuses while idle without producing conversation items",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const updates = [
          { statusKey: "watch", statusText: "\u001b[32mWatching 3 files\u001b[0m\u0007" },
          { statusKey: "lint", statusText: "Lint clean" },
          { statusKey: "watch", statusText: "Watching 4 files" },
          { statusKey: "watch", statusText: "Watching 4 files" },
          { statusKey: "watch", statusText: "\u001b[32mWatching 4 files\u001b[0m" },
          { statusKey: "lint", statusText: "" },
          { statusKey: "missing" },
          { statusKey: "watch" },
          { statusKey: "watch", statusText: "Watching 4 files" },
        ];
        for (const update of updates) {
          yield* fake.emit({ type: "extension_ui_request", method: "setStatus", ...update });
        }
        // The following dialog is an observable milestone after the preceding native notifications.
        yield* fake.emit({
          type: "extension_ui_request",
          id: "status-barrier",
          method: "input",
          title: "Continue?",
        });
        const observed: ProviderAdapter.ProviderAdapterV2Event[] = [];
        yield* takeEvent((event) => {
          observed.push(event);
          return event.type === "runtime_request.updated";
        });
        assert.deepInclude(runtime.providerSession, {
          extensionStatuses: [{ key: "watch", text: "Watching 4 files" }],
        });
        const snapshots = observed.filter((event) => event.type === "provider_session.updated");
        assert.lengthOf(snapshots, 6);
        assert.deepInclude(snapshots[0]?.providerSession, {
          extensionStatuses: [{ key: "watch", text: "Watching 3 files" }],
        });
        assert.deepInclude(snapshots[2]?.providerSession, {
          extensionStatuses: [
            { key: "watch", text: "Watching 4 files" },
            { key: "lint", text: "Lint clean" },
          ],
        });
        assert.isFalse(observed.some((event) => event.type === "message.updated"));
        assert.isFalse(
          observed.some(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type !== "user_input_request",
          ),
        );
        assert.isFalse(
          fake.allRequests().some((request) => request["type"] === "extension_ui_response"),
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("bounds native extension statuses and lets cleared keys free capacity", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      for (let index = 0; index < 35; index++) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: `key-${index}`,
          statusText: index === 1 ? "w".repeat(20000) : "Watching",
        });
      }
      for (const update of [
        { statusKey: "" },
        { statusKey: "x".repeat(257) },
        { statusKey: "malformed", statusText: null },
      ]) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusText: "Invalid",
          ...update,
        });
      }
      yield* fake.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "key-0" });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "replacement",
        statusText: "New status",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "status-barrier",
        method: "input",
        title: "Continue?",
      });
      yield* takeEvent((event) => event.type === "runtime_request.updated");
      const statuses = runtime.providerSession.extensionStatuses ?? [];
      assert.lengthOf(statuses, 32);
      assert.equal(statuses[0]?.key, "key-1");
      assert.equal(statuses[0]?.text.length, 4096);
      assert.deepEqual(statuses.at(-1), { key: "replacement", text: "New status" });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("publishes extension status while native work awaits adoption", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const offers =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        { offer: (offer) => Queue.offer(offers, offer).pipe(Effect.asVoid) },
      );
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({ type: "agent_start" });
      yield* Queue.take(offers);
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "watch",
        statusText: "Native wake",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "status-barrier",
        method: "input",
        title: "Continue?",
      });
      yield* takeEvent((event) => event.type === "runtime_request.updated");
      assert.deepEqual(runtime.providerSession.extensionStatuses, [
        { key: "watch", text: "Native wake" },
      ]);
      const pending = runtime.hasPendingBackgroundWork;
      if (pending === undefined) throw new Error("Missing background work state");
      assert.isTrue(yield* pending);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "keeps extension status through turn settlement and clears it on native session replacement",
    () =>
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
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching",
        });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent((event) => event.type === "turn.terminal");
        assert.deepInclude(runtime.providerSession, {
          status: "ready",
          extensionStatuses: [{ key: "watch", text: "Watching" }],
        });
        yield* startTurn(
          runtime,
          providerThread,
          "anthropic/other-model",
          [],
          "Hello again",
          undefined,
          2,
        );
        assert.deepEqual(runtime.providerSession.extensionStatuses, [
          { key: "watch", text: "Watching" },
        ]);
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent((event) => event.type === "turn.terminal");
        yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        assert.deepInclude(runtime.providerSession, { extensionStatuses: [] });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["model error", "rejected prompt", "failed compact"] as const)(
    "keeps extension status through a reusable %s and the next turn",
    (failure) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching 3 files",
        });
        const command = failure === "failed compact" ? "compact" : "prompt";
        yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          command === "compact" ? "/compact" : "Hello pi",
        );
        yield* fake.takeRequest(command);
        if (failure === "model error") {
          yield* fake.emit({
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: "Rate limited" },
          });
          yield* fake.emit({ type: "agent_settled" });
        } else {
          yield* fake.emit({
            type: "response",
            command,
            success: false,
            error: "Request rejected",
          });
        }
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
        assert.deepInclude(runtime.providerSession, {
          status: "error",
          extensionStatuses: [{ key: "watch", text: "Watching 3 files" }],
        });

        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching 4 files",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "failed-turn-status-barrier",
          method: "input",
          title: "Continue?",
        });
        yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.deepInclude(runtime.providerSession, {
          status: "error",
          extensionStatuses: [{ key: "watch", text: "Watching 4 files" }],
        });

        yield* startTurn(runtime, providerThread, "default", [], "Hello again", undefined, 2);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_settled" });
        const nextTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(nextTerminal.type === "turn.terminal" && nextTerminal.status === "completed");
        assert.deepInclude(runtime.providerSession, {
          id: SESSION_ID,
          status: "ready",
          extensionStatuses: [{ key: "watch", text: "Watching 4 files" }],
        });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("preserves extension statuses when a native session switch is vetoed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "watch",
        statusText: "Watching",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "status-barrier",
        method: "input",
        title: "Continue?",
      });
      yield* takeEvent((event) => event.type === "runtime_request.updated");
      fake.vetoNextSwitch();
      const exit = yield* runtime.resumeThread({ providerThread }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(runtime.providerSession.extensionStatuses, [
        { key: "watch", text: "Watching" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["success", "cancelled", "error"] as const)(
    "handles native status publications during session switch hooks, outcome=%s",
    (outcome) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        for (const key of ["watch", "lint"])
          yield* fake.emit({
            type: "extension_ui_request",
            method: "setStatus",
            statusKey: key,
            statusText: key === "lint" ? "Lint clean" : "Watching",
          });
        fake.deferNextLifecycle("switch_session");
        const switching = yield* runtime
          .resumeThread({ providerThread })
          .pipe(Effect.exit, Effect.forkScoped);
        const request = yield* fake.takeRequest("switch_session");
        yield* fake.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "watch" });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "startup",
          statusText: "Fresh status",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "switch-hook",
          method: "input",
          title: "Continue?",
        });
        yield* takeEvent((event) => event.type === "runtime_request.updated");
        yield* fake.emit({
          type: "response",
          id: request["id"],
          command: "switch_session",
          success: outcome !== "error",
          data: { cancelled: outcome === "cancelled" },
          ...(outcome === "error" ? { error: "Session replacement failed" } : {}),
        });
        const exit = yield* Fiber.join(switching);
        assert.equal(Exit.isFailure(exit), outcome !== "success");
        if (outcome === "error") {
          const reuse = yield* runtime.resumeThread({ providerThread }).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(reuse));
          yield* takeEvent(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "error",
          );
          assert.deepEqual(runtime.providerSession.extensionStatuses, []);
          return;
        }
        assert.deepEqual(runtime.providerSession.extensionStatuses, [
          ...(outcome === "cancelled" ? [{ key: "lint", text: "Lint clean" }] : []),
          { key: "startup", text: "Fresh status" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["stop", "transport death"] as const)(
    "clears extension statuses on %s",
    (retirement) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        const turnStarted = yield* takeEvent((event) => event.type === "provider_turn.updated");
        assert.equal(turnStarted.type, "provider_turn.updated");
        if (turnStarted.type !== "provider_turn.updated") return;
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "status-barrier",
          method: "input",
          title: "Continue?",
        });
        yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.deepInclude(runtime.providerSession, {
          extensionStatuses: [{ key: "watch", text: "Watching" }],
        });
        if (retirement === "stop") {
          yield* runtime.interruptTurn({
            providerThread,
            providerTurnId: turnStarted.providerTurn.id,
            requestRuntimeRestart: true,
          });
        } else yield* fake.closeStdout;
        yield* takeEvent(
          (event) =>
            event.type === "provider_session.updated" &&
            event.providerSession.status === (retirement === "stop" ? "stopped" : "error"),
        );
        assert.deepInclude(runtime.providerSession, { extensionStatuses: [] });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
