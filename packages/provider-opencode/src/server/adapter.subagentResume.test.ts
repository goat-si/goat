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
            permission?: PermissionRuleset;
            metadata?: Record<string, unknown>;
          }) => {
            if (input.sessionID === child) {
              if (previous === "refused") throw new Error("OpenCode refused child permissions");
              if (input.permission !== undefined) {
                childWrites++;
                childSession.permission = input.permission;
              }
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

it.effect.each([
  { recovery: "restart", policyKind: "approval-required" },
  { recovery: "restart", policyKind: "workspace-write" },
  { recovery: "retry", policyKind: "approval-required" },
  { recovery: "retry", policyKind: "workspace-write" },
] as const)(
  "restores exact grandchild permissions after $recovery with $policyKind",
  ({ recovery, policyKind }) =>
    Effect.gen(function* () {
      const root = "permission-root";
      const child = "permission-child";
      const grandchild = "permission-grandchild";
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
      const approval = policyKind === "approval-required";
      const policy = approval
        ? runtimePolicy("approval-required")
        : runtimePolicy("full-access", {
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["/new-root"],
              networkAccess: false,
            },
          });
      const nextBase = openCodePermissionRules(policy);
      const nativeDenies: PermissionRuleset = [
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "read", pattern: "/workspace/private/*", action: "deny" },
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
        [root, { id: root, permission: oldBase, metadata: { goatPermissionBase: oldBase }, time }],
        [
          child,
          {
            id: child,
            parentID: root,
            permission: oldBase,
            metadata: { goatPermissionBase: oldBase },
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
      const action = (rules: PermissionRuleset, permission: string, path: string) =>
        rules.findLast(
          (rule) =>
            (rule.permission === "*" || rule.permission === permission) &&
            (rule.pattern === "*" ||
              rule.pattern === path ||
              (rule.pattern.endsWith("/*") && path.startsWith(rule.pattern.slice(0, -1)))),
        )?.action;
      const submitted: PermissionRuleset[] = [];
      let retainedAfterFailure: unknown[] = [];
      let refuseChildListing = true;
      const open = makeOpenCodeRuntimeHarness("grandchild-policy", root, {
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
            permission?: PermissionRuleset;
            metadata: Record<string, unknown>;
          }) => {
            const next = {
              ...stored(input.sessionID),
              ...(input.permission === undefined
                ? {}
                : {
                    permission:
                      recovery === "restart"
                        ? [...stored(input.sessionID).permission, ...input.permission]
                        : input.permission,
                  }),
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
      const attach = Effect.gen(function* () {
        const harness = yield* open;
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          threadId: harness.threadId,
          runtimePolicy: policy,
        });
        return harness.startTurn("Resume the grandchild", resumed, policy);
      });
      const failScan = Effect.fnUntraced(function* (start: Effect.Success<typeof attach>) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(start)));
        assert.isEmpty(submitted, "the incomplete refresh must block prompt admission");
        assert.deepEqual(stored(root).metadata?.goatPermissionBase, nextBase);
        assert.deepEqual(stored(child).metadata?.goatPermissionBase, nextBase);
        retainedAfterFailure = [root, child].map(
          (id) => stored(id).metadata?.goatPreviousPermissionBases,
        );
        assert.equal(
          action(stored(grandchild).permission, "external_directory", "/old-root/file"),
          "allow",
        );
      });
      if (recovery === "restart") {
        yield* attach.pipe(Effect.flatMap(failScan), Effect.scoped);
      }
      yield* Effect.gen(function* () {
        const start = yield* attach;
        if (recovery === "retry") yield* failScan(start);
        yield* start;
      }).pipe(Effect.scoped);

      // A later refresh must not turn recovered denies back into inherited policy.
      yield* attach.pipe(Effect.flatten, Effect.scoped);
      assert.lengthOf(submitted, 2);
      for (const atPrompt of submitted) {
        assert.equal(
          action(atPrompt, "external_directory", "/old-root/file"),
          approval ? "ask" : "deny",
        );
        assert.equal(
          action(atPrompt, "external_directory", "/new-root/file"),
          approval ? "ask" : "allow",
        );
        assert.equal(action(atPrompt, "read", "/workspace/file"), "allow");
        assert.equal(action(atPrompt, "read", "/workspace/private/file"), "deny");
        assert.equal(action(atPrompt, "task", "general"), "deny");
        assert.includeDeepMembers(atPrompt, nativeDenies);
      }
      assert.deepEqual(retainedAfterFailure, [[oldBase], [oldBase]]);
      assert.isUndefined(stored(root).metadata?.goatPreviousPermissionBases);
      assert.isUndefined(stored(child).metadata?.goatPreviousPermissionBases);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
);

const scopedDirectoryPolicy = (path: string) =>
  runtimePolicy("auto-accept-edits", {
    approvalPolicy: "never",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [path], networkAccess: false },
  });

const childPermissionModes = [
  {
    mode: "approval-required",
    policy: runtimePolicy("approval-required"),
    directory: "ask",
    old: "ask",
  },
  {
    mode: "auto-accept-edits",
    policy: runtimePolicy("auto-accept-edits"),
    directory: "ask",
    old: "ask",
  },
  { mode: "auto", policy: runtimePolicy("auto"), directory: "ask", old: "ask" },
  { mode: "full-access", policy: runtimePolicy("full-access"), directory: "allow", old: "allow" },
  {
    mode: "workspace-write",
    policy: scopedDirectoryPolicy("/new-root"),
    directory: "allow",
    old: "deny",
  },
  {
    mode: "read-only",
    policy: runtimePolicy("full-access", {
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    }),
    directory: "deny",
    old: "deny",
  },
  {
    mode: "read-only-full",
    policy: runtimePolicy("full-access", {
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
    }),
    directory: "allow",
    old: "allow",
  },
  {
    mode: "external-sandbox",
    policy: runtimePolicy("full-access", {
      approvalPolicy: "never",
      sandboxPolicy: { type: "externalSandbox", networkAccess: false },
    }),
    directory: "allow",
    old: "allow",
  },
] as const;

const inheritedPolicyRows = childPermissionModes.flatMap((mode) =>
  [1, 2, 3].flatMap((bases) =>
    Array.from({ length: bases }, (_, createdAfter) =>
      (["none", "restart", "retry"] as const).flatMap((interruption) =>
        [false, true].map((marked) => ({
          ...mode,
          bases,
          createdAfter,
          interruption,
          marked,
          inheritedBlock: true,
          nativeWildcardDenies: false,
        })),
      ),
    ).flat(),
  ),
);

const overlappingNativeDenyRows = childPermissionModes.flatMap((mode) =>
  (
    [
      { bases: 2, createdAfter: 1, marked: true, inheritedBlock: true },
      { bases: 3, createdAfter: 2, marked: false, inheritedBlock: true },
      { bases: 1, createdAfter: 0, marked: false, inheritedBlock: false },
    ] as const
  ).map((row) => ({
    ...mode,
    ...row,
    directory: "deny",
    old: "deny",
    interruption: "restart" as const,
    nativeWildcardDenies: true,
  })),
);

const childPermissionRows = [
  ...[...inheritedPolicyRows, ...overlappingNativeDenyRows].map((row) => ({
    ...row,
    interleavedDeny: false,
  })),
  ...childPermissionModes.map((mode) => ({
    ...mode,
    bases: 2,
    createdAfter: 1,
    interruption: "restart" as const,
    marked: false,
    inheritedBlock: true,
    nativeWildcardDenies: false,
    interleavedDeny: true,
  })),
];

it.effect.each(childPermissionRows)(
  "applies $mode after $bases parent bases, child born after $createdAfter appends, $interruption, marked=$marked, native wildcard denies=$nativeWildcardDenies, inherited block=$inheritedBlock, interleaved deny=$interleavedDeny",
  ({
    policy,
    directory,
    old,
    bases,
    createdAfter,
    interruption,
    marked,
    inheritedBlock,
    nativeWildcardDenies,
    interleavedDeny,
  }) =>
    Effect.gen(function* () {
      const root = "matrix-root";
      const parent = "matrix-parent";
      const child = "matrix-child";
      const time = { created: 1, updated: 1 };
      const history = [
        scopedDirectoryPolicy("/old-root"),
        scopedDirectoryPolicy("/middle-root"),
        scopedDirectoryPolicy("/later-root"),
      ]
        .slice(0, bases)
        .map(openCodePermissionRules);
      const exercisesHistoryLimit = bases === 3 && createdAfter === 2;
      const earlierBases = exercisesHistoryLimit
        ? Array.from({ length: 14 }, (_, index) =>
            openCodePermissionRules(scopedDirectoryPolicy(`/retired-root-${index}`)),
          )
        : [];
      if (exercisesHistoryLimit) {
        // A previous GOAT build recorded a deny outside the current base's finite rule shapes.
        history[0]!.push({ permission: "read", pattern: "/workspace/file", action: "deny" });
      }
      const currentBase = openCodePermissionRules(policy);
      const latest = history.at(-1)!;
      const creationBase = history[createdAfter]!;
      const nativeDenies: PermissionRuleset = [
        ...(nativeWildcardDenies
          ? ([
              { permission: "bash", pattern: "*", action: "deny" },
              { permission: "external_directory", pattern: "*", action: "deny" },
            ] as const)
          : []),
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "read", pattern: "/workspace/private/*", action: "deny" },
      ];
      const parentNativeDeny = {
        permission: "read",
        pattern: "/workspace/parent-private/*",
        action: "deny",
      } as const;
      const appendParentBases = (bases: ReadonlyArray<PermissionRuleset>) =>
        bases.flatMap((base, index) =>
          interleavedDeny && index === 0 ? [...base, parentNativeDeny] : base,
        );
      const inherited = inheritedBlock
        ? appendParentBases(history.slice(0, createdAfter + 1)).filter(
            (rule) => rule.permission === "external_directory" || rule.action === "deny",
          )
        : [];

      type Session = {
        id: string;
        parentID?: string;
        permission: PermissionRuleset;
        metadata?: Record<string, unknown>;
        time: typeof time;
      };
      const restored = interruption === "restart";
      const parentRules =
        restored && bases === 1
          ? currentBase
          : [...appendParentBases(history), ...(restored ? currentBase : [])];
      const parentMetadata = {
        goatPermissionBase: restored ? currentBase : latest,
        ...(restored && bases > 1 ? { goatPreviousPermissionBases: history } : {}),
        ...(exercisesHistoryLimit
          ? { goatPermissionBaseHistory: [...earlierBases, ...history.slice(0, -1)] }
          : {}),
      };
      const sessions = new Map<string, Session>([
        [root, { id: root, time, permission: parentRules, metadata: parentMetadata }],
        [
          parent,
          { id: parent, parentID: root, time, permission: parentRules, metadata: parentMetadata },
        ],
        [
          child,
          {
            id: child,
            parentID: parent,
            time,
            permission: marked
              ? [
                  ...inherited,
                  ...creationBase,
                  ...nativeDenies,
                  { permission: "read", pattern: "/workspace/private/*", action: "allow" },
                ]
              : [...inherited, ...nativeDenies],
            ...(marked ? { metadata: { goatPermissionBase: creationBase } } : {}),
          },
        ],
      ]);
      const stored = (id: string) => {
        const session = sessions.get(id);
        if (session === undefined) throw new Error(`Unexpected test session ${id}`);
        return session;
      };
      let failSubtree = interruption === "retry";
      const submitted: PermissionRuleset[] = [];
      const harness = yield* makeOpenCodeRuntimeHarness("child-policy-matrix", root, {
        event: { subscribe: async () => ({ stream: asyncEventStream().stream }) },
        session: {
          create: async () => ({ data: stored(root) }),
          get: async ({ sessionID }: { sessionID: string }) => ({ data: stored(sessionID) }),
          children: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === parent && failSubtree) {
              failSubtree = false;
              throw new Error("OpenCode could not list this subtree");
            }
            return {
              data: [...sessions.values()].filter((session) => session.parentID === sessionID),
            };
          },
          update: async (input: {
            sessionID: string;
            permission?: PermissionRuleset;
            metadata?: Record<string, unknown>;
          }) => {
            const prior = stored(input.sessionID);
            const next = {
              ...prior,
              permission: [...prior.permission, ...(input.permission ?? [])],
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            };
            sessions.set(input.sessionID, next);
            return { data: next };
          },
          promptAsync: async () => {
            submitted.push(stored(child).permission);
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
      const start = harness.startTurn("Resume the child", resumed, policy);
      if (interruption === "retry") {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(start)));
        assert.deepEqual(stored(parent).metadata?.goatPermissionBase, currentBase);
        assert.isEmpty(submitted);
      }
      yield* start;
      assert.lengthOf(submitted, 1);
      const rules = submitted[0]!;
      const action = (permission: string, path: string) =>
        rules.findLast(
          (rule) =>
            (rule.permission === "*" || rule.permission === permission) &&
            (rule.pattern === "*" ||
              rule.pattern === path ||
              (rule.pattern.endsWith("/*") && path.startsWith(rule.pattern.slice(0, -1)))),
        )?.action;
      assert.deepEqual(
        [
          action("external_directory", "/new-root/file"),
          action("external_directory", "/old-root/file"),
          action("read", "/workspace/file"),
          action("read", "/workspace/private/file"),
        ],
        [directory, old, "allow", "deny"],
        "current directory, previous directory, workspace read, child-native deny",
      );
      if (nativeWildcardDenies) assert.equal(action("bash", "pwd"), "deny");
      if (interleavedDeny) {
        assert.equal(action("read", "/workspace/parent-private/file"), "deny");
      }
      if (exercisesHistoryLimit) {
        assert.deepEqual(
          stored(parent).metadata?.goatPermissionBaseHistory,
          [...earlierBases, ...history].slice(-16),
        );
      }
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
);
