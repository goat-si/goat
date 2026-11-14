/**
 * Failures and settings a live OpenCode 2 server cannot produce on demand,
 * driven through the real adapter and `@opencode/client` against a replayed
 * HTTP server. Frames reuse the shapes recorded against 2.0.18.
 */

import { assert, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";

import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as Stream from "effect/Stream";

import { TestClock } from "effect/testing";

import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";

import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import {
  PROMPT_ID,
  SESSION,
  WORK,
  bigPickle,
  event,
  noOpenRequests,
  opening,
  out,
  policy,
  promptAccepted,
  providerThread,
  reply,
  replyData,
  reconnected,
  resumed,
  sessionInfo,
  threadId,
  turnInput,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

const nativeGoal = (status: "active" | "paused" | "complete") => ({
  id: "goal-1",
  objective: "Write proof.txt",
  status,
  rounds: 2,
  maxRounds: 100,
  boot: "boot-1",
  updatedAt: 1,
  reason: "Checked proof.txt",
});

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect.each(["", "pause", "clear", "resume", "Write proof.txt"])(
    "preserves older OpenCode goal command execution for /goal %s",
    (control) =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed(
          [
            out("command.list", "<any>"),
            reply("command.list", { location: { directory: WORK }, data: [{ name: "goal" }] }),
            out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
            reply("message.list", { data: [], cursor: {} }),
            out("session.command", { sessionID: SESSION, name: "goal", text: control }),
            reply("session.command", null),
            event("session.text.ended", {
              sessionID: SESSION,
              assistantMessageID: "msg_legacy_goal",
              ordinal: 0,
              text: "Legacy command finished",
            }),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          { goal: { objective: "Saved before downgrade", status: "active" } },
        );
        assert.isFalse(runtime.providerSession.capabilities.turns.supportsNativeGoals);
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        yield* runtime.startTurn({
          ...input,
          message: { ...input.message, text: `/goal ${control}`.trim() },
        });
        const collected = yield* Fiber.join(events);
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "assistant_message" &&
              e.turnItem.text === "Legacy command finished",
          ),
        );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }).pipe(Effect.scoped),
  );

  it.effect("reads an existing OpenCode 2.2.5 goal when resuming a session", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntime(
        [
          ...opening,
          out("session.get", { sessionID: SESSION }),
          replyData("session.get", sessionInfo()),
          ...noOpenRequests,
          out("rpc.call", {
            rpcID: "opencode.goal",
            method: "get",
            "location[directory]": WORK,
            input: { sessionID: SESSION },
          }),
          reply("rpc.call", { output: nativeGoal("paused") }),
        ],
        { version: "2.2.5" },
      );
      assert.isTrue(runtime.providerSession.capabilities.turns.supportsNativeGoals);
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      assert.deepEqual(thread.goal, {
        objective: "Write proof.txt",
        status: "paused",
        checks: 2,
        lastCheck: "Checked proof.txt",
      });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { status: "complete", reconnect: false },
    { status: "paused", reconnect: false },
    { status: "complete", reconnect: true },
  ] as const)(
    "keeps an OpenCode goal turn open until $status, with reconnect $reconnect",
    ({ status, reconnect }) =>
      Effect.gen(function* () {
        const recovered = reconnected({ [SESSION]: { type: "running" } });
        const { runtime, thread } = yield* resumed(
          [
            out("command.list", "<any>"),
            reply("command.list", { location: { directory: WORK }, data: [{ name: "goal" }] }),
            out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
            reply("message.list", { data: [], cursor: {} }),
            out("session.command", { sessionID: SESSION, name: "goal", text: "Write proof.txt" }),
            reply("session.command", null),
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal("active") }),
            event("session.execution.succeeded", { sessionID: SESSION }),
            ...(status === "complete"
              ? reconnect
                ? [
                    ...recovered.slice(0, 2),
                    out("rpc.call", "<any>"),
                    reply("rpc.call", { output: nativeGoal("active") }),
                    ...recovered.slice(2),
                    ...noOpenRequests,
                  ]
                : [event("session.execution.started", { sessionID: SESSION })]
              : []),
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal(status) }),
            ...(status === "complete"
              ? [
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_goal_final",
                    ordinal: 0,
                    text: "Final goal output",
                  }),
                  event("session.execution.succeeded", { sessionID: SESSION }),
                ]
              : []),
          ],
          { version: "2.2.5" },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        yield* runtime.startTurn({
          ...input,
          message: { ...input.message, text: "/goal Write proof.txt" },
        });
        const collected = yield* Fiber.join(events);
        const goals = collected.flatMap((e) =>
          e.type === "provider_thread.updated" && e.providerThread.goal
            ? [e.providerThread.goal]
            : [],
        );
        assert.includeDeepMembers(goals, [
          {
            objective: "Write proof.txt",
            status: "active",
            checks: 2,
            lastCheck: "Checked proof.txt",
          },
          {
            objective: "Write proof.txt",
            status,
            checks: 2,
            lastCheck: "Checked proof.txt",
          },
        ]);
        if (status === "complete")
          assert.isTrue(
            collected.some(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "assistant_message" &&
                e.turnItem.text === "Final goal output",
            ),
          );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }).pipe(Effect.scoped),
  );

  it.effect("does not replace a newer goal event with an older goal RPC response", () =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["release-goal-read"]);
      const { runtime, thread } = yield* resumed(
        [
          out("rpc.call", "<any>"),
          event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal("paused") }),
          event(
            "rpc.opencode.goal.changed",
            { sessionID: SESSION, goal: nativeGoal("paused") },
            "release-goal-read",
          ),
          reply("rpc.call", { output: nativeGoal("active") }),
        ],
        { version: "2.2.5", replayGate: gate },
      );
      const changed = yield* Deferred.make<void>();
      const events = yield* runtime.events.pipe(
        Stream.tap((e) =>
          e.type === "provider_thread.updated" && e.providerThread.goal?.status === "paused"
            ? Deferred.succeed(changed, undefined)
            : Effect.void,
        ),
        Stream.takeUntil((e) => e.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const input = turnInput(thread);
      const starting = yield* runtime
        .startTurn({ ...input, message: { ...input.message, text: "/goal" } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(changed);
      gate.release("release-goal-read");
      yield* Fiber.join(starting);
      const collected = yield* Fiber.join(events);
      const updated = collected.findLast((e) => e.type === "provider_thread.updated");
      assert.equal(
        updated?.type === "provider_thread.updated"
          ? updated.providerThread.goal?.status
          : undefined,
        "paused",
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each(["unreadable", "stalled"] as const)(
    "settles a completed execution after reconnect when goal refresh is %s",
    (failure) =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate(["goal-refresh-stalled"]);
        const reconnect = reconnected({}, "succeeded");
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal("active") }),
            ...reconnect.slice(0, 2),
            out("rpc.call", "<any>"),
            reply("rpc.call", failure === "stalled" ? "<hang>" : { output: { unreadable: true } }),
            ...(failure === "stalled"
              ? [
                  event(
                    "rpc.opencode.goal.changed",
                    { sessionID: SESSION, goal: null },
                    "goal-refresh-stalled",
                  ),
                ]
              : []),
            ...reconnect.slice(2),
          ],
          { version: "2.2.5", replayGate: gate },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        if (failure === "stalled") {
          yield* Effect.promise(() => gate.waitForReached("goal-refresh-stalled"));
          gate.release("goal-refresh-stalled");
          yield* TestClock.adjust("5 seconds");
        }
        const collected = yield* Fiber.join(events);
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { initial: "active", recovered: "paused" },
    { initial: "paused", recovered: "active" },
    { initial: "active", recovered: "unreadable" },
  ] as const)(
    "recovers unreadable native goal updates when cached goal is $initial and RPC returns $recovered",
    ({ initial, recovered }) =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal(initial) }),
            event("rpc.opencode.goal.changed", {
              sessionID: SESSION,
              goal: { ...nativeGoal(initial), status: "unknown" },
            }),
            event("session.execution.succeeded", { sessionID: SESSION }),
            out("rpc.call", "<any>"),
            reply("rpc.call", { output: recovered === "unreadable" ? {} : nativeGoal(recovered) }),
            ...(recovered === "active"
              ? [
                  event("session.execution.started", { sessionID: SESSION }),
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_recovered_goal",
                    ordinal: 0,
                    text: "Continued work",
                  }),
                  event("rpc.opencode.goal.changed", {
                    sessionID: SESSION,
                    goal: nativeGoal("complete"),
                  }),
                  event("session.execution.succeeded", { sessionID: SESSION }),
                ]
              : []),
          ],
          { version: "2.2.5" },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const collected = yield* Fiber.join(events);
        const updated = collected.findLast((e) => e.type === "provider_thread.updated");
        assert.equal(
          updated?.type === "provider_thread.updated"
            ? updated.providerThread.goal?.status
            : undefined,
          recovered === "active" ? "complete" : recovered === "paused" ? "paused" : "active",
        );
        if (recovered === "active")
          assert.isTrue(
            collected.some(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "assistant_message" &&
                e.turnItem.text === "Continued work",
            ),
          );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }).pipe(Effect.scoped),
  );

  it.effect.each(["show", "pause", "clear"] as const)(
    "a delayed /goal %s response cannot finish its replacement turn",
    (control) =>
      Effect.gen(function* () {
        const operation = control === "show" ? "rpc.call" : "session.command";
        const { runtime, thread } = yield* resumed(
          [
            ...(control === "show"
              ? []
              : [
                  out("command.list", "<any>"),
                  reply("command.list", {
                    location: { directory: WORK },
                    data: [{ name: "goal" }],
                  }),
                  out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
                  reply("message.list", { data: [], cursor: {} }),
                ]),
            out(operation, "<any>"),
            event("session.execution.interrupted", { sessionID: SESSION, reason: "user" }),
            out("session.prompt", "<any>"),
            promptAccepted,
            reply(operation, control === "show" ? { output: nativeGoal("paused") } : null),
            event("session.text.ended", {
              sessionID: SESSION,
              assistantMessageID: "msg_replacement",
              ordinal: 0,
              text: "Replacement still tracked",
            }),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          { version: "2.2.5" },
        );
        const interrupted = yield* Deferred.make<void>();
        const events = yield* runtime.events.pipe(
          Stream.tap((e) =>
            e.type === "turn.terminal" && e.status === "interrupted"
              ? Deferred.succeed(interrupted, undefined)
              : Effect.void,
          ),
          Stream.takeUntil((e) => e.type === "turn.terminal" && e.status === "completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        const starting = yield* runtime
          .startTurn({
            ...input,
            message: { ...input.message, text: control === "show" ? "/goal" : `/goal ${control}` },
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(interrupted);
        yield* runtime.startTurn({
          ...input,
          attemptId: RunAttemptId.make("replacement"),
          providerTurnOrdinal: 2,
        });
        yield* Fiber.join(starting);
        const collected = yield* Fiber.join(events);
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "assistant_message" &&
              e.turnItem.text === "Replacement still tracked",
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each(["show", "pause", "clear"] as const)(
    "settles OpenCode /goal %s without waiting for an execution",
    (control) =>
      Effect.gen(function* () {
        const goal = control === "clear" ? null : nativeGoal("paused");
        const { runtime, thread } = yield* resumed(
          control === "show"
            ? [out("rpc.call", "<any>"), reply("rpc.call", { output: goal })]
            : [
                out("command.list", "<any>"),
                reply("command.list", { location: { directory: WORK }, data: [{ name: "goal" }] }),
                out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
                reply("message.list", { data: [], cursor: {} }),
                out("session.command", { sessionID: SESSION, name: "goal", text: control }),
                event("rpc.opencode.goal.changed", { sessionID: SESSION, goal }),
                reply("session.command", null),
              ],
          { version: "2.2.5" },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        yield* runtime.startTurn({
          ...input,
          message: { ...input.message, text: control === "show" ? "/goal" : `/goal ${control}` },
        });
        const collected = yield* Fiber.join(events);
        const updated = collected.findLast((e) => e.type === "provider_thread.updated");
        assert.equal(
          updated?.type === "provider_thread.updated"
            ? (updated.providerThread.goal?.status ?? null)
            : undefined,
          goal?.status ?? null,
        );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }).pipe(Effect.scoped),
  );
});
