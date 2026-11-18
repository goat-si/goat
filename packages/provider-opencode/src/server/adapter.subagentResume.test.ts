import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { openCodePermissionRules } from "./permissionRules.ts";
import {
  asyncEventStream,
  makeOpenCodeRuntimeHarness,
  permissionAction,
  runtimePolicy,
} from "./adapter.harness.testkit.ts";

describe("OpenCode resumed task subagents", () => {
  // After a restart the adapter no longer holds the child, so its earlier turns come from OpenCode.
  it.effect.each([
    { case: "in memory", restarted: false },
    { case: "after a restart", restarted: true },
  ])("appends a resumed task child's turn after its earlier turns ($case)", ({ restarted }) =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const root = "ses_root";
      const child = "ses_child";
      let promptId = "";
      const harness = yield* makeOpenCodeRuntimeHarness("resumed-child", root, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
          get: async () => ({
            data: { id: child, parentID: root, permission: [], time: { created: 2, updated: 2 } },
          }),
          update: async () => ({ data: { id: child, parentID: root } }),
          promptAsync: async (input: { messageID: string }) => {
            promptId = input.messageID;
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
          // OpenCode may have stored the resume prompt before its event reaches the adapter.
          messages: async () => ({
            data: [
              { info: { id: "msg_child_first", role: "user" }, parts: [] },
              { info: { id: "msg_child_resume", role: "user" }, parts: [] },
            ],
          }),
        },
      });
      yield* harness.startTurn();
      const childTurns = yield* harness.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.status === "running" &&
            event.providerTurn.providerThreadId.includes(child),
        ),
        Stream.take(restarted ? 1 : 2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const taskPart = (partId: string, status: "running" | "completed", taskId?: string) => ({
        type: "message.part.updated",
        properties: {
          sessionID: root,
          part: {
            id: partId,
            sessionID: root,
            messageID: "msg_root_assistant",
            type: "tool",
            tool: "task",
            callID: `call_${partId}`,
            state: {
              status,
              input: {
                description: "Explore",
                prompt: "look around",
                subagent_type: "general",
                ...(taskId === undefined ? {} : { task_id: taskId }),
              },
              title: "Explore",
              metadata: { parentSessionId: root, sessionId: child },
              time: { start: 3, ...(status === "completed" ? { end: 4 } : {}) },
              ...(status === "completed" ? { output: "done" } : {}),
            },
          },
        },
      });
      const childPrompt = (id: string, created: number) => ({
        type: "message.updated",
        properties: {
          sessionID: child,
          info: { id, sessionID: child, role: "user", time: { created } },
        },
      });
      const status = (sessionID: string, type: "busy" | "idle") => ({
        type: "session.status",
        properties: { sessionID, status: { type } },
      });

      yield* push({
        type: "message.updated",
        properties: {
          sessionID: root,
          info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
        },
      });
      yield* push(status(root, "busy"));
      if (!restarted) {
        yield* push(taskPart("prt_task_first", "running"));
        yield* push(childPrompt("msg_child_first", 3));
        yield* push(status(child, "busy"));
        yield* push(status(child, "idle"));
        yield* push({ type: "session.idle", properties: { sessionID: child } });
        yield* push(taskPart("prt_task_first", "completed"));
      }
      // The lead resumes the same child session by passing its task_id.
      yield* push(taskPart("prt_task_resume", "running", child));
      yield* push(childPrompt("msg_child_resume", 5));
      yield* push(status(child, "busy"));

      const turns = Array.from(yield* Fiber.join(childTurns)).flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn] : [],
      );
      assert.equal(new Set(turns.map((turn) => turn.providerThreadId)).size, 1);
      assert.deepEqual(
        turns.map((turn) => turn.ordinal),
        restarted ? [2] : [1, 2],
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});

it.effect.each([
  "in-memory",
  "in-memory-reattached",
  "persisted",
  "legacy",
  "refused",
  "inherited-approval",
  "inherited-restricted",
  "inherited-verified",
] as const)(
  "replaces the %s child permission base before submitting a downgraded prompt",
  (previous) =>
    Effect.gen(function* () {
      const root = "permission-root";
      const child = "permission-child";
      const full = runtimePolicy("full-access");
      const previousPolicy =
        previous === "inherited-verified"
          ? runtimePolicy("full-access", {
              approvalPolicy: "never",
              sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: ["/old-root"],
                networkAccess: false,
              },
            })
          : full;
      const restricted = runtimePolicy(
        "approval-required",
        previous === "inherited-restricted" ? { approvalPolicy: "never" } : {},
      );
      const fullBase = openCodePermissionRules(previousPolicy);
      const knownChild = previous === "in-memory" || previous === "in-memory-reattached";
      const nativeDeny = { permission: "bash", pattern: "git push *", action: "deny" } as const;
      const inherited = previous.startsWith("inherited-");
      const nativeDenies: PermissionRuleset = inherited
        ? [
            { permission: "todowrite", pattern: "*", action: "deny" },
            { permission: "task", pattern: "*", action: "deny" },
          ]
        : [nativeDeny];
      // Native task creation stores the inherited subset followed by child tool denies.
      const priorRules = inherited
        ? fullBase.filter(
            (rule) => rule.permission === "external_directory" || rule.action === "deny",
          )
        : fullBase;
      const childSession: {
        id: string;
        parentID: string;
        permission: PermissionRuleset;
        metadata: Record<string, unknown>;
        time: { created: number; updated: number };
      } = {
        id: child,
        parentID: root,
        permission: knownChild ? nativeDenies : [...priorRules, ...nativeDenies],
        metadata: {
          owner: "native",
          ...(previous === "persisted" ? { goatPermissionBase: fullBase } : {}),
        },
        time: { created: 2, updated: 2 },
      };
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const rootSession = {
        id: root,
        time: { created: 1, updated: 1 },
        ...(previous === "inherited-verified"
          ? { permission: fullBase, metadata: { goatPermissionBase: fullBase } }
          : {}),
      };
      const submitted: PermissionRuleset[] = [];
      let childWrites = 0;
      let listedChild: typeof childSession | undefined;
      let promptId = "";
      const harness = yield* makeOpenCodeRuntimeHarness("child-policy", root, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: rootSession }),
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === child ? childSession : rootSession,
          }),
          update: async (input: {
            sessionID: string;
            permission: PermissionRuleset;
            metadata?: Record<string, unknown>;
          }) => {
            if (input.sessionID === child) {
              if (previous === "refused") throw new Error("OpenCode refused child permissions");
              childWrites++;
              childSession.permission = input.permission;
              if (input.metadata !== undefined) childSession.metadata = input.metadata;
            }
            return { data: input.sessionID === child ? childSession : rootSession };
          },
          promptAsync: async ({ messageID }: { messageID: string }) => {
            promptId = messageID;
            submitted.push(childSession.permission);
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === root ? [listedChild ?? childSession] : [],
          }),
        },
      });
      if (knownChild) {
        yield* harness.startTurn();
        yield* push({
          type: "message.updated",
          properties: { sessionID: root, info: { id: promptId, role: "user" } },
        });
        yield* push({
          type: "message.part.updated",
          properties: {
            part: {
              id: "task-launch",
              sessionID: root,
              messageID: "task-parent",
              type: "tool",
              tool: "task",
              callID: "call-launch",
              state: {
                status: "running",
                input: { prompt: "Explore" },
                metadata: { sessionId: child },
                time: { start: 2 },
              },
            },
          },
        });
        assert.equal(permissionAction(childSession.permission, "external_directory"), "allow");
        yield* push({ type: "session.idle", properties: { sessionID: root } });
      }
      if (previous === "in-memory-reattached") listedChild = { ...childSession };

      const providerThread =
        previous === "in-memory"
          ? harness.providerThread
          : yield* harness.runtime.resumeThread({
              providerThread: harness.providerThread,
              threadId: harness.threadId,
              runtimePolicy: restricted,
            });
      const started = harness.startTurn("Resume the task", providerThread, restricted);
      if (previous === "refused") {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(started)));
        assert.isEmpty(submitted, "a failed permission write must block the native prompt");
        return;
      }
      yield* started;
      assert.equal(childWrites, knownChild ? 2 : 1);
      const atPrompt = submitted.at(-1) ?? [];
      assert.equal(
        permissionAction(atPrompt, "external_directory"),
        previous === "inherited-restricted" ? "deny" : "ask",
      );
      assert.deepEqual(atPrompt, [...openCodePermissionRules(restricted), ...nativeDenies]);
      assert.deepEqual(
        childSession.metadata.goatPermissionBase,
        openCodePermissionRules(restricted),
      );
      assert.equal(childSession.metadata.owner, "native");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
);

it.effect.each(["restart", "retry"] as const)(
  "revokes an unrefreshed grandchild's old scoped directory access after %s",
  (recovery) =>
    Effect.gen(function* () {
      const root = "permission-root";
      const child = "permission-child";
      const grandchild = "permission-grandchild";
      const oldPattern = "/old-root/*";
      const oldBase = openCodePermissionRules(
        runtimePolicy("full-access", {
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/old-root"],
            networkAccess: false,
          },
        }),
      );
      const policy = runtimePolicy(
        "approval-required",
        recovery === "retry" ? { approvalPolicy: "never" } : {},
      );
      const nextBase = openCodePermissionRules(policy);
      const parentBase = recovery === "restart" ? nextBase : oldBase;
      const nativeDenies: PermissionRuleset = [
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ];
      type NativeSession = {
        id: string;
        parentID?: string;
        permission: PermissionRuleset;
        metadata?: Record<string, unknown>;
        time: { created: number; updated: number };
      };
      const time = { created: 1, updated: 1 };
      const sessions = new Map<string, NativeSession>([
        [
          root,
          { id: root, permission: parentBase, metadata: { goatPermissionBase: parentBase }, time },
        ],
        [
          child,
          {
            id: child,
            parentID: root,
            permission: parentBase,
            metadata: { goatPermissionBase: parentBase },
            time,
          },
        ],
        [
          grandchild,
          {
            id: grandchild,
            parentID: child,
            permission: [
              ...oldBase.filter(
                (rule) => rule.permission === "external_directory" || rule.action === "deny",
              ),
              ...nativeDenies,
            ],
            time,
          },
        ],
      ]);
      const stored = (id: string) => {
        const session = sessions.get(id);
        if (session === undefined) throw new Error(`Unexpected test session ${id}`);
        return session;
      };
      const externalAction = (rules: PermissionRuleset) =>
        rules.findLast(
          (rule) =>
            (rule.permission === "*" || rule.permission === "external_directory") &&
            (rule.pattern === "*" || rule.pattern === oldPattern),
        )?.action;
      const submitted: PermissionRuleset[] = [];
      let refuseChildListing = recovery === "retry";
      const harness = yield* makeOpenCodeRuntimeHarness("grandchild-policy", root, {
        event: { subscribe: async () => ({ stream: asyncEventStream().stream }) },
        session: {
          create: async () => ({ data: stored(root) }),
          get: async ({ sessionID }: { sessionID: string }) => ({ data: stored(sessionID) }),
          children: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === child && refuseChildListing) {
              refuseChildListing = false;
              throw new Error("OpenCode could not list the grandchildren");
            }
            return {
              data: [...sessions.values()].filter((session) => session.parentID === sessionID),
            };
          },
          update: async (input: {
            sessionID: string;
            permission: PermissionRuleset;
            metadata: Record<string, unknown>;
          }) => {
            const next = {
              ...stored(input.sessionID),
              permission: input.permission,
              metadata: input.metadata,
            };
            sessions.set(input.sessionID, next);
            return { data: next };
          },
          promptAsync: async () => {
            submitted.push(stored(grandchild).permission);
            return { data: true };
          },
          abort: async () => ({ data: true }),
        },
      });
      const resumed = yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        threadId: harness.threadId,
        runtimePolicy: policy,
      });
      if (recovery === "retry") {
        const first = yield* Effect.exit(
          harness.startTurn("Resume after downgrade", resumed, policy),
        );
        assert.isTrue(Exit.isFailure(first));
        assert.isEmpty(submitted, "the incomplete refresh must block prompt admission");
      }
      assert.deepEqual(stored(child).metadata?.goatPermissionBase, nextBase);
      assert.equal(externalAction(stored(grandchild).permission), "allow");

      yield* harness.startTurn("Resume the grandchild", resumed, policy);
      assert.lengthOf(submitted, 1);
      const atPrompt = submitted[0] ?? [];
      assert.oneOf(externalAction(atPrompt), ["ask", "deny"]);
      assert.includeDeepMembers(atPrompt, nativeDenies);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
);
