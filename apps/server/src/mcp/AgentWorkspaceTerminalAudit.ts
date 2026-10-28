import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Correlation ids join access intent and outcome without storing request contents.
import * as NodeCrypto from "node:crypto";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
const encodeTarget = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      environment: Schema.String,
      target: Schema.String,
      correlation: Schema.String,
      targetDigest: Schema.String,
      targetTruncated: Schema.Boolean,
    }),
  ),
);
export const newAccessAuditId = () => NodeCrypto.randomUUID();

export class AgentWorkspaceTerminalAudit extends Context.Service<
  AgentWorkspaceTerminalAudit,
  {
    readonly append: (
      scope: McpInvocationScope,
      action: string,
      target: string,
      outcome: string,
      correlation?: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/mcp/AgentWorkspaceTerminalAudit") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return AgentWorkspaceTerminalAudit.of({
    append: Effect.fn("AgentWorkspaceTerminalAudit.append")(
      function* (scope, action, target, outcome, correlation) {
        const time = DateTime.formatIso(yield* DateTime.now);
        const actor = scope.thread
          ? `thread:${scope.thread.threadId}`
          : `client:${scope.client?.sessionId ?? "missing"}`;
        const destination = encodeTarget({
          environment: Array.from(scope.environmentId).slice(0, 256).join(""),
          target: Array.from(target).slice(0, 512).join(""),
          targetDigest: NodeCrypto.createHash("sha256").update(target).digest("hex"),
          targetTruncated: Array.from(target).length > 512,
          correlation: correlation ?? newAccessAuditId(),
        });
        yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${time}, ${actor}, 'agent-workspace-terminal', ${action},
          ${destination}, ${outcome}, NULL)`.pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                reason:
                  outcome === "requested" || outcome === "denied"
                    ? "unavailable"
                    : "outcome_unknown",
                message:
                  "The access audit could not be recorded. Reconcile the target before retrying a mutation.",
              }),
          ),
        );
      },
    ),
  });
});
export const layer = Layer.effect(AgentWorkspaceTerminalAudit, make);
