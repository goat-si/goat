import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { PI_PROVIDER } from "../adapter.ts";
import type * as Fixture from "../adapter.test.ts";
import type * as FakePiModule from "./fakePi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
  /* oxlint-disable goat/no-em-dash-copy -- Matches the Pi extension protocol. */
  it.effect("does not claim a matching dialog from an unrelated Pi tool", () =>
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
      const options = [
        { label: "Yes", description: "Go" },
        { label: "No", description: "Stop" },
      ];
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "other",
        toolName: "other_tool",
        args: { questions: [{ question: "Choose?", options }] },
      });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "select",
        id: "other-dialog",
        title: "Choose?",
        options: ["1. Yes \u2014 Go", "2. No \u2014 Stop", "3. Type something."],
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request")
        return assert.fail("expected request");
      assert.equal(event.turnItem.questions[0]?.options.length, 3);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rejects custom-answer overflow with a visible request error", () =>
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
        type: "tool_execution_start",
        toolCallId: "ask",
        toolName: "ask_user_question",
        args: {
          questions: [
            {
              question: "Choose?",
              options: [
                { label: "Yes", description: "Go" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        },
      });
      for (let i = 0; i < 9; i++) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "select",
          id: `select-${i}`,
          title: "Choose?",
          options: ["1. Yes \u2014 Go", "2. No \u2014 Stop", "3. Type something."],
        });
        const event = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.status === "waiting",
        );
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request")
          return assert.fail("expected request");
        const answer = runtime.respondToRuntimeRequest({
          requestId: event.turnItem.requestId,
          answers: { [`select-${i}`]: `custom-${i}` },
        });
        if (i < 8) {
          yield* answer;
          assert.equal(
            (yield* fake.takeRequest("extension_ui_response"))["value"],
            "3. Type something.",
          );
        } else {
          const error = yield* Effect.flip(answer);
          assert.include(String(error.cause), "Too many Pi custom answers");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["current", "sibling", "ambiguous", "later-user"] as const)(
    "verifies the last legacy turn against %s sessions",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const entry = (id: string, parentId: string | null, seconds: number) => ({
          type: "message",
          id,
          parentId,
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)),
          message: { role: "user" },
        });
        const content =
          [{ type: "session", version: 3 }, entry("prior", null, 10), entry("last", "prior", 30)]
            .map((record) => encodeJson(record))
            .join("\n") + "\n";
        const unrelated =
          [{ type: "session", version: 3 }, entry("other", null, 30)]
            .map((record) => encodeJson(record))
            .join("\n") + "\n";
        yield* fs.writeFileString(
          `${dir}/current.jsonl`,
          scenario === "sibling"
            ? unrelated
            : scenario === "later-user"
              ? content + encodeJson(entry("later", "last", 50)) + "\n"
              : content,
        );
        if (scenario === "sibling" || scenario === "ambiguous")
          yield* fs.writeFileString(`${dir}/old.jsonl`, content);
        const fake = yield* makeFakePi;
        const forkFake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
        const source = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const turn = (ordinal: number) => ({
          id: ProviderTurnId.make(`last-${ordinal}`),
          providerThreadId: source.id,
          nodeId: NodeId.make(`last-node-${ordinal}`),
          runAttemptId: null,
          nativeTurnRef: {
            driver: PI_PROVIDER,
            nativeId: ordinal === 1 ? "prior" : "last",
            strength: "strong" as const,
          },
          ordinal,
          status: "completed" as const,
          startedAt: DateTime.makeUnsafe((ordinal === 1 ? 5 : 20) * 1000),
          completedAt: DateTime.makeUnsafe((ordinal === 1 ? 20 : 40) * 1000),
        });
        forkFake.queueState({ sessionFile: `${dir}/forked.jsonl` });
        fake.queueState({ sessionFile: `${dir}/forked.jsonl` });
        const fork = runtime.forkThread({
          sourceProviderThread: {
            ...source,
            nativeThreadRef: {
              driver: PI_PROVIDER,
              nativeId: `${dir}/current.jsonl`,
              strength: "strong",
            },
          },
          sourceProviderTurns: [turn(1), turn(2)],
          providerTurnId: turn(2).id,
          targetThreadId: ThreadId.make("last-legacy"),
        });
        if (scenario === "ambiguous" || scenario === "later-user") {
          const error = yield* Effect.flip(fork);
          assert.include(
            String(error.cause),
            scenario === "ambiguous"
              ? "multiple matching sibling sessions"
              : "no verified sibling session",
          );
        } else {
          yield* fork;
          const args = forkFake.lastSpawn().args;
          assert.equal(
            args[args.indexOf("--fork") + 1],
            `${dir}/${scenario === "current" ? "current" : "old"}.jsonl`,
          );
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  /* oxlint-enable goat/no-em-dash-copy */
  it.effect("refuses an unverified last legacy turn after a Pi session change", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = {
        id: ProviderTurnId.make("legacy-last"),
        providerThreadId: source.id,
        nodeId: NodeId.make("legacy-node"),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId: "old-entry", strength: "strong" as const },
        ordinal: 1,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe(1000),
        completedAt: DateTime.makeUnsafe(2000),
      };
      forkFake.queueState({ sessionFile: "/fake/incorrect-fork.jsonl" });
      const failure = yield* Effect.flip(
        runtime.forkThread({
          sourceProviderThread: {
            ...source,
            nativeThreadRef: {
              driver: PI_PROVIDER,
              nativeId: "/fake/new-session.jsonl",
              strength: "strong",
            },
          },
          sourceProviderTurns: [turn],
          providerTurnId: turn.id,
          targetThreadId: ThreadId.make("legacy-last-fork"),
        }),
      );
      assert.include(String(failure.cause), "Cannot recover Pi fork session");
      assert.isFalse(forkFake.allRequests().some((request) => request.type === "fork"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("forks a historical Pi turn from its recorded session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const oldRef = {
        driver: PI_PROVIDER,
        nativeId: "/fake/old.jsonl",
        strength: "strong",
      } as const;
      const newRef = {
        driver: PI_PROVIDER,
        nativeId: "/fake/new.jsonl",
        strength: "strong",
      } as const;
      const turn = (ordinal: number) => ({
        id: ProviderTurnId.make(`historical-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`historical-node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: {
          driver: PI_PROVIDER,
          nativeId: `entry-${ordinal}`,
          strength: "strong" as const,
        },
        nativeThreadRef: oldRef,
        ordinal,
        status: "completed" as const,
        startedAt: null,
        completedAt: null,
      });
      forkFake.queueState({ sessionFile: "/fake/result.jsonl" });
      fake.queueState({ sessionFile: "/fake/result.jsonl" });
      yield* runtime.forkThread({
        sourceProviderThread: { ...source, nativeThreadRef: newRef },
        sourceProviderTurns: [turn(1), turn(2)],
        providerTurnId: turn(1).id,
        targetThreadId: ThreadId.make("historical-fork"),
      });
      const args = forkFake.lastSpawn().args;
      assert.equal(args[args.indexOf("--fork") + 1], oldRef.nativeId);
      assert.equal(
        forkFake.allRequests().find((request) => request.type === "fork")?.entryId,
        "entry-2",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    "match",
    "wrong-branch",
    "wrong-time",
    "ambiguous",
    "malformed",
    "missing",
    "unreadable",
  ] as const)("recovers a legacy Pi fork only from verified session data: %s", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const entry = (id: string, parentId: string | null, seconds: number) => ({
        type: "message",
        id,
        parentId,
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)),
        message: { role: "user" },
      });
      const history = [
        entry(scenario === "missing" ? "other" : "entry-1", null, 10),
        entry(
          "entry-2",
          scenario === "wrong-branch" ? null : "entry-1",
          scenario === "wrong-time" ? 100 : 30,
        ),
      ];
      const content =
        scenario === "malformed"
          ? "not-json\n"
          : [{ type: "session", version: 3 }, ...history]
              .map((record) => encodeJson(record))
              .join("\n") + "\n";
      yield* fs.writeFileString(`${dir}/old.jsonl`, content);
      if (scenario === "ambiguous") yield* fs.writeFileString(`${dir}/also-old.jsonl`, content);
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number) => ({
        id: ProviderTurnId.make(`legacy-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`legacy-node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: {
          driver: PI_PROVIDER,
          nativeId: `entry-${ordinal}`,
          strength: "strong" as const,
        },
        ordinal,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe((ordinal === 1 ? 5 : 20) * 1000),
        completedAt: DateTime.makeUnsafe((ordinal === 1 ? 20 : 40) * 1000),
      });
      forkFake.failNextFork();
      forkFake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      fake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      const fork = runtime.forkThread({
        sourceProviderThread: {
          ...source,
          nativeThreadRef: {
            driver: PI_PROVIDER,
            nativeId:
              scenario === "unreadable" ? `${dir}/missing/current.jsonl` : `${dir}/current.jsonl`,
            strength: "strong",
          },
        },
        sourceProviderTurns: [turn(1), turn(2)],
        providerTurnId: turn(1).id,
        targetThreadId: ThreadId.make("legacy-fork"),
      });
      if (scenario === "match") {
        yield* fork;
        const args = forkFake.lastSpawn().args;
        assert.equal(args[args.indexOf("--fork") + 1], `${dir}/old.jsonl`);
      } else {
        const error = yield* Effect.flip(fork);
        assert.include(String(error.cause), "Cannot recover Pi fork session");
      }
      assert.equal(yield* fs.readFileString(`${dir}/old.jsonl`), content);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["completed", "interrupted"] as const)(
    "records the Pi session before and after a %s turn",
    (outcome) =>
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
        yield* fake.emit({ type: "agent_start" });
        const running = yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (running.type !== "provider_turn.updated") return assert.fail("expected a running turn");
        assert.deepEqual(running.providerTurn.nativeThreadRef, providerThread.nativeThreadRef);
        if (outcome === "interrupted") {
          yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
        } else {
          yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
        }
        yield* fake.emit({ type: "agent_settled" });
        const finished = yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === outcome,
        );
        if (finished.type !== "provider_turn.updated")
          return assert.fail("expected a terminal turn");
        assert.deepEqual(finished.providerTurn.nativeThreadRef, providerThread.nativeThreadRef);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

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
      const forkIndex = requests.findIndex((request) => request.type === "fork");
      assert.include(fake.lastSpawn().args, "--session");
      assert.include(fake.lastSpawn().args, sessionFile);
      assert.isFalse(requests.some((request) => request.type === "switch_session"));
      assert.isAtLeast(forkIndex, 0, "fresh runtime never forked the attached session");
      assert.equal(requests[forkIndex]?.entryId, "u2");
      if (result._tag !== "Success") return;
      assert.equal(
        result.success.providerThread.nativeThreadRef?.nativeId,
        "/fake/rolled-back-session.jsonl",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
