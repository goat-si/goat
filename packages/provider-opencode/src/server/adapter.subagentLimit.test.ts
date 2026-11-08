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
import {
  asyncEventStream,
  makeOpenCodeRuntimeHarness,
  runtimePolicy,
} from "./adapter.harness.testkit.ts";

type Rule = { permission: string; pattern: string; action: string };
type Update = {
  sessionID: string;
  permission: ReadonlyArray<Rule>;
  metadata?: Record<string, unknown>;
};
const DENY = { permission: "task", pattern: "*", action: "deny" };
const REVIEWER = { permission: "task", pattern: "reviewer", action: "allow" };
const USER_READ = { permission: "read", pattern: "*", action: "allow" };

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
  const calls: Array<{ sessionID: string; permission?: ReadonlyArray<Rule> }> = [];
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
      fork: async () => ({
        data: { id: `${root}-fork`, time: { created: 2, updated: 2 }, permission: [] },
      }),
      update: async (input: Update) => {
        if (input.sessionID !== root && options.childUpdateFails?.() === true)
          throw new Error("child update refused");
        updates.push(input);
        calls.push({ sessionID: input.sessionID, permission: input.permission });
        Queue.offerUnsafe(updated, input);
        return { data: { id: input.sessionID, time: { created: 1, updated: 1 } } };
      },
      promptAsync: async (input: { messageID: string; sessionID: string }) => {
        payloads.push(input);
        calls.push({ sessionID: input.sessionID });
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
  return { calls, harness, payloads, push, root, sessions, config, status, turn, updated, updates };
});

const resumeFixture = Effect.fn("resumeFixture")(function* (
  suffix: string,
  native: { permission?: ReadonlyArray<Rule>; metadata?: Record<string, unknown> },
  options: { readonly refuseUpdate?: () => boolean } = {},
) {
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const nativeEvents = asyncEventStream();
  const updates: Array<Update> = [];
  const prompts: Array<string> = [];
  const created = { count: 0 };
  const root = `${suffix}-root`;
  const harness = yield* makeOpenCodeRuntimeHarness(suffix, root, {
    event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
    session: {
      create: async () => {
        created.count += 1;
        return { data: { id: root, time: { created: 1, updated: 1 } } };
      },
      get: async (input: { sessionID: string }) => ({
        data: { id: input.sessionID, time: { created: 1, updated: 2 }, ...native },
      }),
      update: async (input: Update) => {
        updates.push(input);
        if (options.refuseUpdate?.() === true) throw new Error("session update refused");
        return { data: { id: input.sessionID, time: { created: 1, updated: 3 } } };
      },
      promptAsync: async (input: { sessionID: string }) => {
        prompts.push(input.sessionID);
        return { data: true };
      },
      abort: async () => ({ data: true }),
      children: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
    },
  });
  const config = {
    environmentId: EnvironmentId.make("fixture"),
    threadId: harness.threadId,
    providerSessionId: `session-opencode-${suffix}`,
    providerInstanceId: ProviderInstanceId.make(`opencode-${suffix}`),
    endpoint: "http://fixture.invalid/mcp",
    authorizationHeader: "Bearer resume-fixture",
    browserToolsAvailable: false,
  };
  return { config, created, harness, prompts, root, sessions, updates };
});

describe("OpenCode native subagent limit", () => {
  it.effect("installs GOAT rules on a fork before its first prompt (#2239)", () =>
    Effect.gen(function* () {
      const { calls, harness, root, sessions, config } = yield* limitHarness(
        "fork-permission",
        (permission) => ({ permission }),
      );
      const targetPolicy = runtimePolicy("approval-required", { cwd: "/workspace" });
      const fork = yield* harness.runtime.forkThread({
        sourceProviderThread: harness.providerThread,
        targetThreadId: ThreadId.make("fork-target"),
        runtimePolicy: targetPolicy,
      });
      yield* sessions.set({ ...config, nativeSubagentLimit: 0 });
      yield* harness.startTurn("work", fork);
      const sessionID = `${root}-fork`;
      const rules = openCodePermissionRules(targetPolicy);
      assert.deepEqual(calls, [
        { sessionID, permission: rules },
        { sessionID, permission: [...rules, DENY] },
        { sessionID },
      ]);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

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

  it.effect(
    "refreshes a stale full-access base on resume and keeps the session's own rules (#2477)",
    () =>
      Effect.gen(function* () {
        const fullAccess = runtimePolicy("full-access");
        const approval = runtimePolicy("approval-required");
        const stale = [...openCodePermissionRules(fullAccess), REVIEWER, DENY];
        const { config, created, harness, root, sessions, updates } = yield* resumeFixture(
          "resume-stale-base",
          { permission: stale, metadata: { goatSubagentDeny: true } },
        );
        yield* sessions.set({ ...config, nativeSubagentLimit: 0 });
        yield* harness.runtime.resumeThread({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          runtimePolicy: approval,
        });
        const base = openCodePermissionRules(approval);
        assert.equal(created.count, 1);
        assert.deepEqual(updates, [
          {
            sessionID: root,
            permission: [...base, REVIEWER, DENY],
            metadata: { goatSubagentDeny: true, goatPermissionBase: base },
          },
        ]);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect(
    "keeps the resumed session when the permission refresh fails and retries it before the next prompt (#2477)",
    () =>
      Effect.gen(function* () {
        const fullAccess = runtimePolicy("full-access");
        const approval = runtimePolicy("approval-required");
        const stale = [...openCodePermissionRules(fullAccess), REVIEWER, DENY];
        const { config, created, harness, prompts, root, sessions, updates } = yield* resumeFixture(
          "resume-update-fails",
          { permission: stale, metadata: { goatSubagentDeny: true } },
          { refuseUpdate: () => true },
        );
        yield* sessions.set({ ...config, nativeSubagentLimit: 0 });
        const resumed = yield* harness.runtime.resumeThread({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          runtimePolicy: approval,
        });
        assert.equal(created.count, 1);
        const failed = yield* Effect.exit(harness.startTurn("work", resumed, approval));
        assert.isTrue(Exit.isFailure(failed));
        assert.equal(prompts.length, 0);
        assert.equal(created.count, 1);
        const base = openCodePermissionRules(approval);
        assert.deepEqual(
          updates.map((update) => update.permission),
          [
            [...base, REVIEWER, DENY],
            [...base, REVIEWER, DENY],
          ],
        );
        assert.deepEqual(
          updates.map((update) => update.metadata),
          [
            { goatSubagentDeny: true, goatPermissionBase: base },
            { goatSubagentDeny: true, goatPermissionBase: base },
          ],
        );
        assert.equal(
          updates.every((update) => update.sessionID === root),
          true,
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect(
    "installs GOAT's base when resuming a pre-#2239 fork with an empty permission list (#2477)",
    () =>
      Effect.gen(function* () {
        const approval = runtimePolicy("approval-required");
        const { config, created, harness, root, sessions, updates } = yield* resumeFixture(
          "resume-empty-fork",
          { permission: [] },
        );
        yield* sessions.set(config);
        yield* harness.runtime.ensureThread({
          threadId: harness.threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode-resume-empty-fork"),
            model: "anthropic/claude-sonnet",
            options: [],
          },
          runtimePolicy: approval,
          existingProviderThread: harness.providerThread,
        });
        const base = openCodePermissionRules(approval);
        assert.equal(created.count, 1);
        assert.deepEqual(updates, [
          {
            sessionID: root,
            permission: base,
            metadata: { goatPermissionBase: base, goatSubagentDeny: false },
          },
        ]);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect(
    "strips a legacy GOAT prefix from a different policy and keeps the user's rules (#2477)",
    () =>
      Effect.gen(function* () {
        const approval = runtimePolicy("approval-required");
        const fullAccess = runtimePolicy("full-access");
        const { config, harness, root, sessions, updates } = yield* resumeFixture(
          "resume-legacy-prefix",
          { permission: [...openCodePermissionRules(approval), REVIEWER] },
        );
        yield* sessions.set(config);
        yield* harness.runtime.resumeThread({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          runtimePolicy: fullAccess,
        });
        const base = openCodePermissionRules(fullAccess);
        assert.deepEqual(updates, [
          {
            sessionID: root,
            permission: [...base, REVIEWER],
            metadata: { goatPermissionBase: base, goatSubagentDeny: false },
          },
        ]);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect(
    "strips the recorded goatPermissionBase and keeps a following rule GOAT could have written (#2477)",
    () =>
      Effect.gen(function* () {
        const fullAccess = runtimePolicy("full-access");
        const approval = runtimePolicy("approval-required");
        const recorded = openCodePermissionRules(fullAccess);
        const { config, harness, root, sessions, updates } = yield* resumeFixture(
          "resume-recorded-base",
          {
            permission: [...recorded, USER_READ, REVIEWER, DENY],
            metadata: { goatPermissionBase: recorded, goatSubagentDeny: true },
          },
        );
        yield* sessions.set({ ...config, nativeSubagentLimit: 0 });
        yield* harness.runtime.resumeThread({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          runtimePolicy: approval,
        });
        const base = openCodePermissionRules(approval);
        assert.deepEqual(updates, [
          {
            sessionID: root,
            permission: [...base, USER_READ, REVIEWER, DENY],
            metadata: { goatSubagentDeny: true, goatPermissionBase: base },
          },
        ]);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );
});
