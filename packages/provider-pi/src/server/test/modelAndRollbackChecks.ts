import { registerTokenUsageChecks } from "./tokenUsageChecks.ts";
import { registerPiModelTailChecks } from "./modelAndRollbackTailChecks.ts";
import { assert, it } from "@effect/vitest";
import { NodeId, ProviderTurnId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { PI_PROVIDER } from "../adapter.ts";
import { PiCustomAnswers } from "../extensionDialog.ts";
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
  registerTokenUsageChecks({
    makeFakePi,
    openRuntime,
    startTurn,
    THREAD_ID,
    modelSelection,
    runtimePolicy,
    layerTest,
  });
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
  /* oxlint-disable goat/no-em-dash-copy -- Matches the Pi extension protocol. */
  it.effect("releases the shared custom-answer budget when a Pi session closes", () =>
    Effect.gen(function* () {
      const holders = Array.from({ length: 4 }, () => new PiCustomAnswers());
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const holder of holders) holder.clear();
        }),
      );
      const route = (prefix: string) => ({
        optionLines: [],
        sentinel: "1. Type something.",
        followUpTitlePrefix: prefix,
      });
      for (const [index, holder] of holders.entries())
        for (let i = 0; i < (index === 3 ? 63 : 64); i++)
          assert.isNotNull(holder.route(route(`q-${index}-${i}`), { value: "held" }));
      const probe = holders[3];
      if (probe === undefined) return assert.fail("missing holder");
      yield* Effect.scoped(
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
                  question: "Close?",
                  options: [
                    { label: "Yes", description: "Go" },
                    { label: "No", description: "Stop" },
                  ],
                },
              ],
            },
          });
          yield* fake.emit({
            type: "extension_ui_request",
            method: "select",
            id: "close-test",
            title: "Close?",
            options: ["1. Yes \u2014 Go", "2. No \u2014 Stop", "3. Type something."],
          });
          const event = yield* takeEvent(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
          );
          if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request")
            return assert.fail("expected request");
          yield* runtime.respondToRuntimeRequest({
            requestId: event.turnItem.requestId,
            answers: { "close-test": "custom" },
          });
          yield* fake.takeRequest("extension_ui_response");
          assert.isNull(probe.route(route("overflow"), { value: "held" }));
        }),
      );
      assert.isNotNull(probe.route(route("released"), { value: "held" }));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  /* oxlint-enable goat/no-em-dash-copy */
  it.effect("recovers a verified legacy target before a turn in another session", () =>
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
        [{ type: "session", version: 3 }, entry("prior", null, 10), entry("target", "prior", 30)]
          .map((record) => encodeJson(record))
          .join("\n") + "\n";
      yield* fs.writeFileString(`${dir}/old.jsonl`, content);
      yield* fs.writeFileString(
        `${dir}/new.jsonl`,
        [{ type: "session", version: 3 }, entry("later", null, 50)]
          .map((record) => encodeJson(record))
          .join("\n") + "\n",
      );
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number, nativeId: string) => ({
        id: ProviderTurnId.make(`cross-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`cross-node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId, strength: "strong" as const },
        ordinal,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe((ordinal * 20 - 15) * 1000),
        completedAt: DateTime.makeUnsafe(ordinal * 20 * 1000),
      });
      const later = {
        ...turn(3, "later"),
        nativeThreadRef: {
          driver: PI_PROVIDER,
          nativeId: `${dir}/new.jsonl`,
          strength: "strong" as const,
        },
      };
      forkFake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      fake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      yield* runtime.forkThread({
        sourceProviderThread: { ...source, nativeThreadRef: later.nativeThreadRef },
        sourceProviderTurns: [turn(1, "prior"), turn(2, "target"), later],
        providerTurnId: turn(2, "target").id,
        targetThreadId: ThreadId.make("cross-session-verified"),
      });
      const args = forkFake.lastSpawn().args;
      assert.equal(args[args.indexOf("--fork") + 1], `${dir}/old.jsonl`);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("never forks an unverified legacy target from a later referenced session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const target = {
        id: ProviderTurnId.make("legacy-target"),
        providerThreadId: source.id,
        nodeId: NodeId.make("legacy-target-node"),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId: "old-entry", strength: "strong" as const },
        ordinal: 1,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe(1000),
        completedAt: DateTime.makeUnsafe(2000),
      };
      const later = {
        ...target,
        id: ProviderTurnId.make("later"),
        ordinal: 2,
        nativeTurnRef: {
          driver: PI_PROVIDER,
          nativeId: "later-entry",
          strength: "strong" as const,
        },
        nativeThreadRef: {
          driver: PI_PROVIDER,
          nativeId: "/fake/different-session.jsonl",
          strength: "strong" as const,
        },
      };
      forkFake.queueState({ sessionFile: "/fake/bad-fork.jsonl" });
      const failure = yield* Effect.flip(
        runtime.forkThread({
          sourceProviderThread: source,
          sourceProviderTurns: [target, later],
          providerTurnId: target.id,
          targetThreadId: ThreadId.make("legacy-cross-session"),
        }),
      );
      assert.include(String(failure.cause), "Cannot recover Pi fork session");
      assert.isFalse(forkFake.allRequests().some((request) => request.type === "fork"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "recovers a legacy target before an uncaptured Pi boundary using the on-disk branch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const entry = (id: string, parentId: string | null, role: string, seconds: number) => ({
          type: "message",
          id,
          parentId,
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)),
          message: {
            role,
            content: [{ type: "text", text: "synthetic" }],
            timestamp: seconds * 1000,
          },
        });
        const entries = [
          entry("u1", null, "user", 10),
          entry("a1", "u1", "assistant", 20),
          entry("u2", "a1", "user", 110),
          entry("a2", "u2", "assistant", 120),
        ];
        yield* fs.writeFileString(
          `${dir}/current.jsonl`,
          [
            {
              type: "session",
              version: 3,
              id: "synthetic",
              cwd: "/workspace",
              timestamp: "1970-01-01T00:00:00.000Z",
            },
            ...entries,
          ]
            .map((record) => encodeJson(record))
            .join("\n") + "\n",
        );
        const fake = yield* makeFakePi;
        const forkFake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
        const source = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const target = {
          id: ProviderTurnId.make("target-weak"),
          providerThreadId: source.id,
          nodeId: NodeId.make("target-node"),
          runAttemptId: null,
          nativeTurnRef: { driver: PI_PROVIDER, nativeId: "u1", strength: "strong" as const },
          ordinal: 1,
          status: "completed" as const,
          startedAt: DateTime.makeUnsafe(0),
          completedAt: DateTime.makeUnsafe(50000),
        };
        const next = {
          ...target,
          id: ProviderTurnId.make("uncaptured"),
          ordinal: 2,
          nativeTurnRef: { driver: PI_PROVIDER, nativeId: "synthetic", strength: "weak" as const },
          startedAt: DateTime.makeUnsafe(100000),
          completedAt: DateTime.makeUnsafe(200000),
        };
        forkFake.queueEntries({ entries, leafId: "a2" });
        forkFake.queueState({ sessionFile: `${dir}/forked.jsonl` });
        fake.queueState({ sessionFile: `${dir}/forked.jsonl` });
        yield* runtime.forkThread({
          sourceProviderThread: {
            ...source,
            nativeThreadRef: {
              driver: PI_PROVIDER,
              nativeId: `${dir}/current.jsonl`,
              strength: "strong",
            },
          },
          sourceProviderTurns: [target, next],
          providerTurnId: target.id,
          targetThreadId: ThreadId.make("legacy-weak"),
        });
        assert.equal(
          forkFake.allRequests().find((request) => request.type === "fork")?.entryId,
          "u2",
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("refuses ambiguous target sessions even when a later boundary is unique", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const e = (id: string, parentId: string | null, seconds: number) => ({
        type: "message",
        id,
        parentId,
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)),
        message: { role: "user", content: [] },
      });
      const header = {
        type: "session",
        version: 3,
        id: "synthetic",
        cwd: "/workspace",
        timestamp: "1970-01-01T00:00:00.000Z",
      };
      yield* fs.writeFileString(
        `${dir}/current.jsonl`,
        [header, e("target", null, 10), e("boundary", "target", 30)]
          .map((x) => encodeJson(x))
          .join("\n") + "\n",
      );
      yield* fs.writeFileString(
        `${dir}/old.jsonl`,
        [header, e("target", null, 10)].map((x) => encodeJson(x)).join("\n") + "\n",
      );
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number, nativeId: string) => ({
        id: ProviderTurnId.make(`ambiguous-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`node-ambiguous-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId, strength: "strong" as const },
        ordinal,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe((ordinal * 20 - 15) * 1000),
        completedAt: DateTime.makeUnsafe(ordinal * 20 * 1000),
      });
      forkFake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      fake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      const error = yield* Effect.flip(
        runtime.forkThread({
          sourceProviderThread: {
            ...source,
            nativeThreadRef: {
              driver: PI_PROVIDER,
              nativeId: `${dir}/current.jsonl`,
              strength: "strong",
            },
          },
          sourceProviderTurns: [turn(1, "target"), turn(2, "boundary")],
          providerTurnId: turn(1, "target").id,
          targetThreadId: ThreadId.make("ambiguous-target"),
        }),
      );
      assert.include(String(error.cause), "multiple matching sibling sessions");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("forks before a verified legacy boundary even when Pi recorded a later steer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const entry = (id: string, parentId: string | null, seconds: number) => ({
        type: "message",
        id,
        parentId,
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)),
        message: { role: "user", content: [] },
      });
      const entries = [
        entry("target", null, 10),
        entry("next", "target", 110),
        entry("steer", "next", 130),
      ];
      yield* fs.writeFileString(
        `${dir}/current.jsonl`,
        [
          {
            type: "session",
            version: 3,
            id: "synthetic",
            cwd: "/workspace",
            timestamp: "1970-01-01T00:00:00.000Z",
          },
          ...entries,
        ]
          .map((x) => encodeJson(x))
          .join("\n") + "\n",
      );
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number, nativeId: string) => ({
        id: ProviderTurnId.make(`steer-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`steer-node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId, strength: "strong" as const },
        ordinal,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe((ordinal === 1 ? 0 : 100) * 1000),
        completedAt: DateTime.makeUnsafe((ordinal === 1 ? 50 : 150) * 1000),
      });
      forkFake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      fake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      yield* runtime.forkThread({
        sourceProviderThread: {
          ...source,
          nativeThreadRef: {
            driver: PI_PROVIDER,
            nativeId: `${dir}/current.jsonl`,
            strength: "strong",
          },
        },
        sourceProviderTurns: [turn(1, "target"), turn(2, "next")],
        providerTurnId: turn(1, "target").id,
        targetThreadId: ThreadId.make("steered-legacy"),
      });
      assert.equal(
        forkFake.allRequests().find((request) => request.type === "fork")?.entryId,
        "next",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("recovers a single legacy turn from a Pi-format session without a second turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const records = [
        {
          type: "session",
          version: 3,
          id: "synthetic-session",
          timestamp: "1970-01-01T00:00:01.000Z",
          cwd: "/workspace",
        },
        {
          type: "message",
          id: "a1b2c3d4",
          parentId: null,
          timestamp: "1970-01-01T00:00:10.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "synthetic prompt" }],
            timestamp: 10000,
          },
        },
        {
          type: "message",
          id: "e5f6a7b8",
          parentId: "a1b2c3d4",
          timestamp: "1970-01-01T00:00:11.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "synthetic reply" }],
            timestamp: 11000,
          },
        },
      ];
      yield* fs.writeFileString(
        `${dir}/current.jsonl`,
        records.map((record) => encodeJson(record)).join("\n") + "\n",
      );
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const target = {
        id: ProviderTurnId.make("one-turn"),
        providerThreadId: source.id,
        nodeId: NodeId.make("one-node"),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId: "a1b2c3d4", strength: "strong" as const },
        ordinal: 1,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe(9000),
        completedAt: DateTime.makeUnsafe(12000),
      };
      forkFake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      fake.queueState({ sessionFile: `${dir}/forked.jsonl` });
      yield* runtime.forkThread({
        sourceProviderThread: {
          ...source,
          nativeThreadRef: {
            driver: PI_PROVIDER,
            nativeId: `${dir}/current.jsonl`,
            strength: "strong",
          },
        },
        sourceProviderTurns: [target],
        providerTurnId: target.id,
        targetThreadId: ThreadId.make("one-fork"),
      });
      const args = forkFake.lastSpawn().args;
      assert.equal(args[args.indexOf("--fork") + 1], `${dir}/current.jsonl`);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

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

  registerPiModelTailChecks({
    makeFakePi,
    makeAdapter,
    openRuntime,
    startTurn,
    THREAD_ID,
    SESSION_ID,
    modelSelection,
    runtimePolicy,
    layerTest,
  });
}
