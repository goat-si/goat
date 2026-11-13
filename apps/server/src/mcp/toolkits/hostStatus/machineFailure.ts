import { type HubMachinesError, OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../../McpInvocationContext.ts";

/** Attach tools act for the calling thread, which the switch must name. */
export const threadOf = (scope: McpInvocationScope) =>
  scope.thread === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message: "Only a GOAT thread the hub setting names may attach machines.",
        }),
      )
    : Effect.succeed(scope.thread.threadId);

/** The MCP failure for an attach refusal; the reason stays first in the message. */
export const machineFailure = (error: HubMachinesError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid_request" || error.reason === "name_rule"
        ? "invalid_request"
        : error.reason === "not_found"
          ? "not_found"
          : error.reason === "cap_reached"
            ? "capacity_exceeded"
            : error.reason === "key_in_use" || error.reason === "conflict"
              ? "conflict"
              : error.reason === "unknown_outcome" || error.reason === "storage_failed"
                ? "orchestration_error"
                : "capability_denied",
    message: error.reason + ": " + error.detail,
    ...(error.reason === "unknown_outcome"
      ? { mayHaveStarted: true, reconcile: "goat_hub_machine_list" }
      : {}),
  });
