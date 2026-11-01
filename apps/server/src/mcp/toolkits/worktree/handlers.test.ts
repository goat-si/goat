import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as WorktreeInventoryService from "../../WorktreeInventoryService.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as WorktreeHandlers from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

interface HostCall {
  readonly writes: boolean;
  readonly host: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Calls one worktree tool as a GOAT thread or an outside client, recording where it went. */
const call = (
  tool: "goat_worktree_inventory" | "goat_worktree_remove" | "goat_worktree_cleanup",
  params: Record<string, unknown>,
  options: {
    /** An outside client with this access calls instead of a GOAT thread. */
    readonly clientAccess?: "read-only" | "auto" | "full-access";
    readonly threadRuntimeMode?: "approval-required" | "auto-accept-edits" | "full-access";
    readonly threadInteractionMode?: "default" | "plan";
  } = {},
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("caller");
    const hostCalls: Array<HostCall> = [];
    const localCalls: Array<string> = [];
    const answer = { worktrees: [], dryRun: true, removed: [], kept: [] } as never;
    // One answer that decodes as every worktree tool's result.
    const remoteAnswer = {
      ...(answer as object),
      path: "/r/wt",
      branch: null,
      branchDeleted: false,
      notes: [],
    };
    const onHost =
      (writes: boolean) =>
      (
        _scope: unknown,
        input: Omit<HostCall, "writes">,
        decode: (value: unknown) => Effect.Effect<object, Error>,
      ) =>
        Effect.sync(() => hostCalls.push({ writes, ...input })).pipe(
          Effect.andThen(decode(remoteAnswer)),
          Effect.map((value) => ({ ...value, host: input.host })),
        );
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread:
          options.clientAccess !== undefined
            ? undefined
            : {
                threadId,
                providerSessionId: "session",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
        client:
          options.clientAccess !== undefined
            ? { sessionId: "client", label: "Outside agent", access: options.clientAccess }
            : undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration", "worktree"] as const),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(
            liveThreadShell(threadId, {
              ...(options.threadRuntimeMode === undefined
                ? {}
                : { runtimeMode: options.threadRuntimeMode }),
              ...(options.threadInteractionMode === undefined
                ? {}
                : { interactionMode: options.threadInteractionMode }),
            }),
          ),
      }),
      Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({
        readOnHost: onHost(false) as never,
        writeOnHost: onHost(true) as never,
      }),
      Layer.mock(WorktreeInventoryService.WorktreeInventoryService)({
        inventory: () =>
          Effect.sync(() => localCalls.push("inventory")).pipe(Effect.as(remoteAnswer as never)),
        remove: () =>
          Effect.sync(() => localCalls.push("remove")).pipe(Effect.as(remoteAnswer as never)),
        cleanup: () =>
          Effect.sync(() => localCalls.push("cleanup")).pipe(Effect.as(remoteAnswer as never)),
      }),
      Layer.mock(WorktreeMcpService.WorktreeMcpService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    );
    const toolkit = yield* WorktreeToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(WorktreeHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const responses = yield* toolkit
      .handle(tool, params as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return { result: responses.at(-1)?.result as unknown, hostCalls, localCalls };
  });

it.effect("sends a host call to the same tool on that host without the host argument", () =>
  Effect.gen(function* () {
    const inventory = yield* call("goat_worktree_inventory", { host: "box", repo: "/r" });
    const remove = yield* call("goat_worktree_remove", { host: "box", path: "/r/wt", force: true });
    expect([...inventory.hostCalls, ...remove.hostCalls]).toEqual([
      { writes: false, host: "box", tool: "goat_worktree_inventory", arguments: { repo: "/r" } },
      {
        writes: true,
        host: "box",
        tool: "goat_worktree_remove",
        arguments: { path: "/r/wt", force: true },
      },
    ]);
    expect([...inventory.localCalls, ...remove.localCalls]).toEqual([]);
    expect(remove.result).toMatchObject({ host: "box" });
  }),
);

it.effect("opens a writing host session only for a real cleanup sweep", () =>
  Effect.gen(function* () {
    const preview = yield* call("goat_worktree_cleanup", { host: "box" });
    const sweep = yield* call("goat_worktree_cleanup", { host: "box", dryRun: false });
    expect([...preview.hostCalls, ...sweep.hostCalls].map((entry) => entry.writes)).toEqual([
      false,
      true,
    ]);
  }),
);

it.effect("lets a read-only client preview a cleanup but not run one", () =>
  Effect.gen(function* () {
    const preview = yield* call("goat_worktree_cleanup", {}, { clientAccess: "read-only" });
    expect(preview.localCalls).toEqual(["cleanup"]);
    const sweep = yield* call(
      "goat_worktree_cleanup",
      { dryRun: false },
      { clientAccess: "read-only" },
    );
    expect(sweep.localCalls).toEqual([]);
    expect(sweep.result).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect.each([
  ["an approval-required thread", { threadRuntimeMode: "approval-required" }],
  ["a plan-mode thread", { threadInteractionMode: "plan" }],
  ["an auto client", { clientAccess: "auto" }],
] as const)("refuses %s removing worktrees, while it may still preview", ([, options]) =>
  Effect.gen(function* () {
    const remove = yield* call("goat_worktree_remove", { path: "/r/wt" }, options);
    const sweep = yield* call("goat_worktree_cleanup", { dryRun: false }, options);
    for (const denied of [remove, sweep]) {
      expect(denied.localCalls).toEqual([]);
      expect(denied.result).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("Removing worktrees needs"),
      });
    }
    const preview = yield* call("goat_worktree_cleanup", {}, options);
    expect(preview.localCalls).toEqual(["cleanup"]);
  }),
);

it.effect("lets a full-access thread or client remove worktrees", () =>
  Effect.gen(function* () {
    const thread = yield* call("goat_worktree_remove", { path: "/r/wt" });
    const client = yield* call(
      "goat_worktree_cleanup",
      { dryRun: false },
      {
        clientAccess: "full-access",
      },
    );
    expect([...thread.localCalls, ...client.localCalls]).toEqual(["remove", "cleanup"]);
  }),
);
