import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { openCodePermissionRules } from "./adapter.ts";
import { asyncEventStream, makeOpenCodeRuntimeHarness } from "./adapter.harness.testkit.ts";

type Rule = { permission: string; pattern: string; action: string };
type Update = {
  sessionID: string;
  permission: ReadonlyArray<Rule>;
  metadata?: Record<string, unknown>;
};
const DENY = { permission: "task", pattern: "*", action: "deny" };

/** A thread whose OpenCode session opens with `opened`, and a turn that runs to idle. */
const limitHarness = Effect.fn("limitHarness")(function* (
  suffix: string,
  opened: (permission: ReadonlyArray<Rule>) => {
    permission: ReadonlyArray<Rule>;
    metadata?: Record<string, unknown>;
  },
  options: { readonly childUpdateFails?: () => boolean } = {},
) {
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const nativeEvents = asyncEventStream();
  const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
  const root = `${suffix}-root`;
  const payloads: Array<{ messageID: string }> = [];
  const updates: Array<Update> = [];
  const updated = yield* Queue.unbounded<Update>();
  const config = {
    environmentId: EnvironmentId.make("fixture"),
    threadId: ThreadId.make(`thread-opencode-${suffix}`),
    providerSessionId: `session-opencode-${suffix}`,
    providerInstanceId: ProviderInstanceId.make(`opencode-${suffix}`),
    endpoint: "http://fixture.invalid/mcp",
    authorizationHeader: "Bearer limit-fixture",
    browserToolsAvailable: false,
  };
  const harness = yield* makeOpenCodeRuntimeHarness(suffix, root, {
    event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
    session: {
      create: async (input: { permission: ReadonlyArray<Rule> }) => ({
        data: { id: root, time: { created: 1, updated: 1 }, ...opened(input.permission) },
      }),
      get: async (input: { sessionID: string }) => ({
        data: {
          id: input.sessionID,
          parentID: root,
          permission: [],
          time: { created: 2, updated: 2 },
        },
      }),
      update: async (input: Update) => {
        if (input.sessionID !== root && options.childUpdateFails?.() === true)
          throw new Error("child update refused");
        updates.push(input);
        Queue.offerUnsafe(updated, input);
        return { data: { id: input.sessionID, time: { created: 1, updated: 1 } } };
      },
      promptAsync: async (input: { messageID: string }) => {
        payloads.push(input);
        return { data: true };
      },
      abort: async () => ({ data: true }),
      children: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
    },
  });
  const status = (sessionID: string, type: "busy" | "idle") => ({
    type: "session.status",
    properties: { sessionID, status: { type } },
  });
  /** One turn under `limit`; `during` runs while the root is busy. */
  const turn = (
    limit: number | undefined,
    during: Effect.Effect<void, never, Scope.Scope> = Effect.void,
  ) =>
    Effect.gen(function* () {
      yield* sessions.set(limit === undefined ? config : { ...config, nativeSubagentLimit: limit });
      yield* harness.startTurn("work");
      const terminal = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* push({
        type: "message.updated",
        properties: {
          sessionID: root,
          info: { id: payloads.at(-1)!.messageID, role: "user", time: { created: 1 } },
        },
      });
      yield* push(status(root, "busy"));
      yield* during;
      yield* push(status(root, "idle"));
      yield* Fiber.join(terminal);
    });
  return { harness, payloads, push, root, sessions, config, status, turn, updated, updates };
});

describe("OpenCode native subagent limit", () => {
  it.effect("adds and removes only GOAT's task deny, keeping the session's own rules", () =>
    Effect.gen(function* () {
      const own = [{ permission: "task", pattern: "reviewer", action: "allow" }, DENY];
      const { harness, turn, updates } = yield* limitHarness("subagent-limit", (permission) => ({
        permission: [...permission, ...own],
      }));
      const native = [...openCodePermissionRules(harness.policy), ...own];
      // A session's own trailing deny is not GOAT's to remove while goatclaw is off.
      yield* turn(undefined);
      yield* turn(0);
      yield* turn(undefined);
      yield* turn(3);
      yield* turn(0);
      // OpenCode has no concurrency cap: only zero denies, and a positive limit leaves rules alone.
      assert.deepEqual(
        updates.map((update) => update.permission),
        [[...native, DENY], native, [...native, DENY]],
      );
      assert.deepEqual(
        updates.map((update) => update.metadata?.goatSubagentDeny),
        [true, false, true],
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("removes a deny an earlier GOAT left once goatclaw is off", () =>
    Effect.gen(function* () {
      const { harness, turn, updates } = yield* limitHarness("stale-limit", (permission) => ({
        permission: [...permission, DENY],
        metadata: { goatSubagentDeny: true },
      }));
      yield* turn(undefined);
      assert.deepEqual(
        updates.map((update) => update.permission),
        [openCodePermissionRules(harness.policy)],
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each([false, true])(
    "carries a new zero limit to a child session before the prompt, child update fails=%s",
    (childFails) =>
      Effect.gen(function* () {
        let failing = false;
        const { harness, push, root, status, turn, updates } = yield* limitHarness(
          `child-limit-${childFails}`,
          (permission) => ({ permission }),
          { childUpdateFails: () => failing },
        );
        const child = `${root}-child`;
        const task = (state: "running" | "completed") => ({
          type: "message.part.updated",
          properties: {
            sessionID: root,
            part: {
              id: "prt_task",
              sessionID: root,
              messageID: "msg_root_assistant",
              type: "tool",
              tool: "task",
              callID: "call_task",
              state: {
                status: state,
                input: {
                  description: "Background task",
                  prompt: "sleep",
                  subagent_type: "general",
                },
                title: "Background task",
                metadata: { parentSessionId: root, sessionId: child, background: true },
                time: { start: 3, ...(state === "completed" ? { end: 3 } : {}) },
                ...(state === "completed" ? { output: "Background task started" } : {}),
              },
            },
          },
        });
        yield* turn(
          undefined,
          Effect.gen(function* () {
            yield* push(task("running"));
            yield* push({
              type: "session.created",
              properties: {
                sessionID: child,
                info: { id: child, parentID: root, time: { created: 2, updated: 2 } },
              },
            });
            yield* push(status(child, "busy"));
            yield* push(task("completed"));
          }),
        );
        const childRules = updates.at(-1)!;
        assert.equal(childRules.sessionID, child);
        failing = childFails;
        const second = yield* Effect.exit(turn(0));
        assert.equal(Exit.isFailure(second), childFails);
        if (childFails) return;
        assert.deepEqual(
          updates.slice(-2).map((update) => [update.sessionID, update.permission]),
          [
            [root, [...openCodePermissionRules(harness.policy), DENY]],
            [child, [...childRules.permission, DENY]],
          ],
        );
        // Lifting the limit is best effort for a child, and one that failed is tried again.
        failing = true;
        yield* turn(undefined);
        assert.equal(updates.at(-1)?.sessionID, root);
        failing = false;
        yield* turn(undefined);
        assert.deepEqual(
          [updates.at(-1)?.sessionID, updates.at(-1)?.permission],
          [child, childRules.permission],
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect("denies subagents before a steering message once the limit is zero", () =>
    Effect.gen(function* () {
      const { harness, payloads, push, sessions, config, root, turn, updated } =
        yield* limitHarness("steer-limit", (permission) => ({ permission }));
      yield* turn(
        undefined,
        Effect.gen(function* () {
          const snapshot = yield* harness.runtime.readThreadSnapshot({
            providerThread: harness.providerThread,
          });
          yield* sessions.set({ ...config, nativeSubagentLimit: 0 });
          const steer = harness.runtime
            .steerTurn({
              threadId: harness.threadId,
              runId: harness.runId,
              providerThread: harness.providerThread,
              providerTurnId: snapshot.providerTurns.at(-1)!.id,
              message: {
                messageId: MessageId.make("message-opencode-steer-limit"),
                text: "more",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            })
            .pipe(Effect.exit);
          assert.isTrue(Exit.isSuccess(yield* steer));
          assert.deepEqual(yield* Queue.take(updated), {
            sessionID: root,
            permission: [...openCodePermissionRules(harness.policy), DENY],
            metadata: { goatSubagentDeny: true },
          });
          // The steer's own receipt lets the turn settle.
          yield* push({
            type: "message.updated",
            properties: {
              sessionID: root,
              info: { id: payloads.at(-1)!.messageID, role: "user", time: { created: 1 } },
            },
          });
        }).pipe(Effect.orDie),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("refuses a native command that would run as a subtask while the limit is zero", () =>
    Effect.gen(function* () {
      const suffix = "subtask-limit";
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const nativeEvents = asyncEventStream();
      const calls = yield* Queue.unbounded<{ messageID: string; command: string }>();
      let agentsFail = false;
      yield* sessions.set({
        environmentId: EnvironmentId.make("fixture"),
        threadId: ThreadId.make(`thread-opencode-${suffix}`),
        providerSessionId: `session-opencode-${suffix}`,
        providerInstanceId: ProviderInstanceId.make(`opencode-${suffix}`),
        endpoint: "http://fixture.invalid/mcp",
        authorizationHeader: "Bearer subtask-fixture",
        browserToolsAvailable: false,
        nativeSubagentLimit: 0,
      });
      const harness = yield* makeOpenCodeRuntimeHarness(suffix, "subtask-root", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        command: {
          list: async () => ({
            data: [
              { name: "background", template: "", hints: [], subtask: true },
              { name: "scout", template: "", hints: [], agent: "explore" },
              { name: "docs", template: "", hints: [], agent: "build" },
            ],
          }),
        },
        app: {
          agents: async () => {
            if (agentsFail) throw new Error("agents unavailable");
            return {
              data: [
                { name: "build", mode: "primary", permission: [] },
                { name: "explore", mode: "subagent", permission: [] },
              ],
            };
          },
        },
        session: {
          create: async () => ({
            data: { id: "subtask-root", time: { created: 1, updated: 1 } },
          }),
          update: async () => ({ data: { id: "subtask-root", time: { created: 1, updated: 1 } } }),
          command: async (input: { messageID: string; command: string }) => {
            Queue.offerUnsafe(calls, input);
            return { data: true };
          },
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
        },
      });
      for (const text of ["/background now", "/scout the repo"]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(harness.startTurn(text))));
      }
      agentsFail = true;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(harness.startTurn("/docs build"))));
      assert.isTrue(Option.isNone(yield* Queue.poll(calls)));
      agentsFail = false;
      const start = yield* harness.startTurn("/docs build").pipe(Effect.forkScoped);
      const call = yield* Queue.take(calls);
      assert.equal(call.command, "docs");
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "subtask-root",
            info: {
              id: call.messageID,
              sessionID: "subtask-root",
              role: "user",
              time: { created: DateTime.toEpochMillis(harness.now) },
            },
          },
        }),
      );
      yield* Fiber.join(start);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});
