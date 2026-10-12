import {
  type ChannelGatewayError,
  type ChannelInboundMessage,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ChannelGateway from "../../../channels/ChannelGateway.ts";
import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import * as ChannelWorkerReports from "../../../channels/ChannelWorkerReports.ts";
import { channelOwnerIdFor } from "../../../channels/channelOwner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ChannelToolkit } from "./tools.ts";

const failureFor = (error: ChannelGatewayError | ChannelLedger.ChannelLedgerError) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "ChannelGatewayError" && error.reason === "not_home"
        ? "not_home"
        : error._tag === "ChannelGatewayError" && error.reason === "not_found"
          ? "task_not_found"
          : error._tag === "ChannelGatewayError" &&
              (error.reason === "invalid_input" || error.reason === "idempotency_conflict")
            ? "invalid_request"
            : error._tag === "ChannelGatewayError" && error.reason === "forbidden"
              ? "capability_denied"
              : "orchestration_error",
    message:
      error._tag === "ChannelGatewayError" && error.reason === "not_home"
        ? error.message +
          (error.homeEnvironmentId === undefined
            ? ""
            : " Home environment: " + error.homeEnvironmentId)
        : error.message,
  });

const ownerIdOf = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => channelOwnerIdFor(scope.environmentId)),
);

const notFound = () =>
  new OrchestratorMcpFailure({ code: "task_not_found", message: "No such GOAT ledger task." });

/** The ingress context an MCP caller acts in. */
const mcpContextOf = (scope: McpInvocationContext.McpInvocationScope) => ({
  ownerId: channelOwnerIdFor(scope.environmentId),
  principalId: "mcp:" + scope.requestNamespace,
  displayName: scope.client?.label ?? "Agent",
  // Agents never start work (reception refuses it), so they only need to read.
  grantedScopes: ["orchestration:read" as const],
  runtimeModeCeiling: McpInvocationContext.clientRuntimeModeCeiling(scope.client),
  caller: {
    type: "mcp" as const,
    requestNamespace: scope.requestNamespace,
    ...(scope.thread === undefined ? {} : { callerThreadId: scope.thread.threadId }),
  },
});

export const layer = McpToolAccess.toLayer(ChannelToolkit, {
  channel_ingest: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const conversationKey = input.conversationKey ?? "default";
      const message: ChannelInboundMessage = {
        kind: "mcp",
        connectionId: ChannelGateway.MCP_CONNECTION_ID,
        conversationKey,
        externalMessageId: input.clientRequestId,
        idempotencyKey: input.clientRequestId,
        actor: {
          ...(scope.thread === undefined
            ? {}
            : { senderThreadId: scope.thread.threadId, senderEnvironmentId: scope.environmentId }),
          ...(scope.client === undefined ? {} : { displayName: scope.client.label }),
        },
        replyAddress: {
          kind: "mcp",
          connectionId: ChannelGateway.MCP_CONNECTION_ID,
          requestNamespace: scope.requestNamespace,
          conversationKey,
        },
        text: input.text,
        attachments: [],
        receivedAt: DateTime.formatIso(yield* DateTime.now),
        intent: "message",
      };
      return yield* gateway.ingest(message, mcpContextOf(scope)).pipe(Effect.mapError(failureFor));
    }),
  ),
  channel_input_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const gateway = yield* ChannelGateway.ChannelGateway;
      return yield* gateway.getInput(input.inputId, mcpContextOf(scope)).pipe(
        Effect.mapError((error) =>
          error.reason === "not_found"
            ? new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "No such message from this caller.",
              })
            : failureFor(error),
        ),
      );
    }),
  ),
  channel_task_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const ownerId = yield* ownerIdOf;
      const stored = yield* ledger.getTask(input.taskId).pipe(Effect.mapError(failureFor));
      if (stored === undefined || stored.ownerId !== ownerId) return yield* notFound();
      return stored.task;
    }),
  ),
  channel_task_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const page = yield* ledger
        .listTasks({
          ownerId: yield* ownerIdOf,
          statuses: input.status,
          limit: input.limit ?? 50,
          cursor: input.cursor,
        })
        .pipe(Effect.mapError(failureFor));
      return {
        tasks: page.tasks,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    }),
  ),
  channel_task_report: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* reports.report(input, scope.thread?.threadId).pipe(Effect.mapError(failureFor));
      return {};
    }),
  ),
});
