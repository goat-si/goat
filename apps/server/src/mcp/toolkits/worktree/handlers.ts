import {
  OrchestratorMcpFailure,
  WorktreeMcpCleanupResult,
  WorktreeMcpInventoryResult,
  WorktreeMcpRemoveResult,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeInventoryService from "../../WorktreeInventoryService.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import { WorktreeToolkit } from "./tools.ts";

const requireWorktreeCapability = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) =>
    context.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential cannot manage worktrees.",
          }),
        ),
  ),
);

/**
 * Runs `local` here, or the same tool on `host`, which answers for its own
 * worktrees. `writes` picks a host session that may change things. A keyed write is admitted
 * after the credential check, so a replay passes it again.
 */
const hereOrOnHost = <P extends { readonly host?: string | undefined }, A extends object, E>(
  tool: string,
  input: P,
  writes: boolean,
  decode: (value: unknown) => Effect.Effect<A, E>,
  local: (
    input: Omit<P, "host">,
  ) => Effect.Effect<A, OrchestratorMcpFailure, WorktreeInventoryService.WorktreeInventoryService>,
) =>
  Effect.gen(function* () {
    yield* requireWorktreeCapability;
    yield* McpToolAccess.admit(input);
    const { host, ...rest } = input;
    if (host === undefined) return yield* local(rest);
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
    const call = { host, tool, arguments: rest };
    return yield* writes
      ? hosts.writeOnHost(scope, call, decode)
      : hosts.readOnHost(scope, call, decode);
  });

const decodeInventory = Schema.decodeUnknownEffect(WorktreeMcpInventoryResult);
const decodeRemove = Schema.decodeUnknownEffect(WorktreeMcpRemoveResult);
const decodeCleanup = Schema.decodeUnknownEffect(WorktreeMcpCleanupResult);
const inventoryService = WorktreeInventoryService.WorktreeInventoryService;

const handlers = {
  goat_worktree_inventory: McpToolAccess.readsOrReachesHost(
    (input) => input.host !== undefined,
    (input) =>
      hereOrOnHost("goat_worktree_inventory", input, false, decodeInventory, (local) =>
        Effect.flatMap(inventoryService, (service) => service.inventory(local)),
      ),
  ),
  goat_worktree_remove: McpToolAccess.removesCheckouts(
    () => true,
    () => true,
    (input) =>
      hereOrOnHost("goat_worktree_remove", input, true, decodeRemove, (local) =>
        Effect.flatMap(inventoryService, (service) => service.remove(local)),
      ),
    { admission: "handler" },
  ),
  // A dry run changes nothing, so only a real sweep needs a full-access caller.
  goat_worktree_cleanup: McpToolAccess.removesCheckouts(
    (input) => input.dryRun === false,
    (input) => input.host !== undefined,
    (input) =>
      hereOrOnHost("goat_worktree_cleanup", input, input.dryRun === false, decodeCleanup, (local) =>
        Effect.flatMap(inventoryService, (service) => service.cleanup(local)),
      ),
  ),
  goat_worktree_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* McpInvocationContext.McpInvocationContext;
      if (!context.capabilities.has("worktree"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot inspect worktrees.",
        });
      const { threadId, ...refs } = input;
      const {
        projection: { thread },
      } = yield* readThread(threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const git = yield* GitWorkflow.GitWorkflowService;
      return yield* git
        .listRefs({ ...refs, cwd: thread.worktreePath ?? project.value.workspaceRoot })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  goat_worktree_handoff: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* WorktreeMcpService.WorktreeMcpService;
        return yield* service.handoff(scope, input);
      }),
    ),
  ),
  goat_worktree_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.status(scope);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof WorktreeToolkit.tools>;

export const layer = McpToolAccess.toLayer(WorktreeToolkit, handlers);
