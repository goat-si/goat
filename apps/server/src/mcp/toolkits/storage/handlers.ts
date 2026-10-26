import {
  OrchestratorMcpFailure,
  StorageMcpUsageResult,
  type StorageMcpCleanResult,
  type StorageMcpCleanInput,
  type StorageMcpUsageInput,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as StorageConsent from "../../../storage/StorageConsent.ts";
import * as StorageReclaim from "../../../storage/StorageReclaim.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const decodeUsage = Schema.decodeUnknownEffect(StorageMcpUsageResult);
const failed = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** goat_storage_usage and goat_storage_clean, spread into the worktree toolkit's handlers. */
export const storageHandlers = {
  goat_storage_usage: McpToolAccess.readsOrReachesHost(
    (input: StorageMcpUsageInput) => input.host !== undefined,
    (input: StorageMcpUsageInput) =>
      Effect.gen(function* () {
        const { host, ...rest } = input;
        if (host !== undefined) {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
          return yield* hosts.readOnHost(
            scope,
            { host, tool: "goat_storage_usage", arguments: rest },
            decodeUsage,
          );
        }
        const reclaim = yield* StorageReclaim.StorageReclaim;
        return yield* reclaim.usage({ rescan: rest.rescan === true }).pipe(Effect.mapError(failed));
      }),
  ),
  // A dry run deletes nothing; deleting needs a full-access caller and a person's approval.
  goat_storage_clean: McpToolAccess.removesCheckouts(
    (input: StorageMcpCleanInput) => input.dryRun === false,
    () => false,
    (input: StorageMcpCleanInput) =>
      Effect.gen(function* (): Effect.fn.Return<
        StorageMcpCleanResult,
        OrchestratorMcpFailure,
        | StorageReclaim.StorageReclaim
        | StorageConsent.StorageConsent
        | McpInvocationContext.McpInvocationContext
      > {
        const reclaim = yield* StorageReclaim.StorageReclaim;
        const report = yield* reclaim.usage({ rescan: false }).pipe(Effect.mapError(failed));
        const requested = input.items;
        const chosen =
          requested === undefined
            ? report.items.filter((item) => item.selected && item.state === "removable")
            : report.items.filter((item) =>
                requested.some((entry) => entry.id === item.id && entry.token === item.token),
              );
        if (input.dryRun !== false || chosen.length === 0)
          return {
            kind: "preview",
            items: chosen,
            bytes: chosen.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
          };
        if (requested !== undefined && chosen.length !== requested.length)
          return yield* invalid(
            "Some items are not in the latest scan as given; they changed or are gone. " +
              goatCallText("storage.usage") +
              " lists them again.",
          );
        // Without items, the approval binds the default selection exactly as it is now.
        const items = requested ?? chosen.map(({ id, token }) => ({ id, token }));
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const consent = yield* StorageConsent.StorageConsent;
        if (input.approvalId === undefined) {
          const asked = yield* consent.ask(scope, items, chosen);
          if (asked.kind === "handoff")
            return {
              kind: "needs_human",
              handoff: asked.handoff,
              next: { after: "approval", call: "goat_storage_clean" },
            };
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "Deleting needs a person's approval. GOAT filed decision " +
              asked.decisionId +
              " for exactly these items; once a person approves it, call again with the same items and approvalId " +
              asked.decisionId +
              ".",
          });
        }
        yield* consent.admit(scope, input.approvalId, items);
        const actor =
          scope.thread !== undefined
            ? "thread:" + scope.thread.threadId
            : "mcp-client:" + (scope.client?.sessionId ?? "unknown");
        const result = yield* reclaim
          .clean({ items, actor: actor + " approval:" + input.approvalId })
          .pipe(Effect.mapError(failed));
        return { kind: "cleaned", ...result };
      }),
  ),
};
