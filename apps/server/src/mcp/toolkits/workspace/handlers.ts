import * as Effect from "effect/Effect";
import * as Service from "../../AgentWorkspaceMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { WorkspaceToolkit } from "./tools.ts";

export const layer = Access.toLayer(WorkspaceToolkit, {
  goat_workspace_list: Access.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* Service.AgentWorkspaceMcpService).list(
        yield* McpInvocationContext,
        input,
      );
    }),
  ),
  goat_workspace_read: Access.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* Service.AgentWorkspaceMcpService).read(
        yield* McpInvocationContext,
        input,
      );
    }),
  ),
  goat_workspace_search: Access.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* Service.AgentWorkspaceMcpService).search(
        yield* McpInvocationContext,
        input,
      );
    }),
  ),
});
