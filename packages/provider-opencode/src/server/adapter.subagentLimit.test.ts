import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { openCodePermissionRules } from "./adapter.ts";
import {
  asyncEventStream,
  permissionAction,
  makeOpenCodeRuntimeHarness,
} from "./adapter.harness.testkit.ts";

describe("OpenCode native subagent limit", () => {
  it.effect("denies OpenCode's task tool to the session while the goatclaw limit is zero", () =>
    Effect.gen(function* () {
      const suffix = "subagent-limit";
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const nativeEvents = asyncEventStream();
      type Rule = { permission: string; pattern: string; action: string };
      const payloads: Array<{ messageID: string }> = [];
      const updates: Array<ReadonlyArray<Rule>> = [];
      const created: Array<ReadonlyArray<Rule>> = [];
      const config = {
        environmentId: EnvironmentId.make("fixture"),
        threadId: ThreadId.make(`thread-opencode-${suffix}`),
        providerSessionId: `session-opencode-${suffix}`,
        providerInstanceId: ProviderInstanceId.make(`opencode-${suffix}`),
        endpoint: "http://fixture.invalid/mcp",
        authorizationHeader: "Bearer limit-fixture",
        browserToolsAvailable: false,
      };
      yield* sessions.set({ ...config, nativeSubagentLimit: 0 });
      const harness = yield* makeOpenCodeRuntimeHarness(suffix, "limit-root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async (input: { permission: ReadonlyArray<Rule> }) => {
            created.push(input.permission);
            return {
              data: {
                id: "limit-root",
                permission: input.permission,
                time: { created: 1, updated: 1 },
              },
            };
          },
          update: async (input: { permission: ReadonlyArray<Rule> }) => {
            updates.push(input.permission);
            return { data: { id: "limit-root", time: { created: 1, updated: 1 } } };
          },
          promptAsync: async (input: { messageID: string }) => {
            payloads.push(input);
            return { data: true };
          },
          abort: async () => ({ data: true }),
        },
      });
      const turn = Effect.gen(function* () {
        yield* harness.startTurn("work");
        const terminal = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const messageID = payloads.at(-1)!.messageID;
        for (const event of [
          {
            type: "message.updated",
            properties: {
              sessionID: "limit-root",
              info: { id: messageID, role: "user", time: { created: 1 } },
            },
          },
          {
            type: "session.status",
            properties: { sessionID: "limit-root", status: { type: "busy" } },
          },
          {
            type: "session.status",
            properties: { sessionID: "limit-root", status: { type: "idle" } },
          },
        ])
          yield* Effect.promise(() => nativeEvents.push(event));
        yield* Fiber.join(terminal);
      });
      const deniesTask = (rules: ReadonlyArray<Rule> | undefined) =>
        permissionAction(rules as ReturnType<typeof openCodePermissionRules>, "task") === "deny";
      assert.isTrue(deniesTask(created[0]));
      yield* turn;
      assert.deepEqual(updates, []);
      yield* sessions.set(config);
      yield* turn;
      yield* sessions.set({ ...config, nativeSubagentLimit: 3 });
      yield* turn;
      yield* sessions.set({ ...config, nativeSubagentLimit: 0 });
      yield* turn;
      // OpenCode has no concurrency cap: only zero denies, and a positive limit leaves the rules alone.
      assert.deepEqual(updates.map(deniesTask), [false, true]);
      assert.deepEqual(updates[0], openCodePermissionRules(harness.policy));
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
