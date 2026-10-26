import {
  type ChannelGatewayError,
  type ChannelInboundMessage,
  OrchestratorMcpFailure,
  ServerSettingsError,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ChannelBotHome from "../../../channels/ChannelBotHome.ts";
import * as ChannelGateway from "../../../channels/ChannelGateway.ts";
import * as ChannelTaskExport from "../../../channels/ChannelTaskExport.ts";
import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import * as ChannelRemoteWorkers from "../../../channels/ChannelRemoteWorkers.ts";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";
import * as ChannelWorkerReports from "../../../channels/ChannelWorkerReports.ts";
import { channelOwnerIdFor } from "../../../channels/channelOwner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
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
            : " Home environment: " + error.homeEnvironmentId + ".") +
          " If that machine is gone, call goat_channel_bot_home_claim on the machine that should run GOAT Bot."
        : error.message,
  });

/** Marks a caller that lost full access while the claim waited for the settings write lock. */
const HOME_CLAIM_REVOKED = "<goat-bot-home-claim-revoked>";

const HOME_CLAIM_DENIAL =
  "Moving GOAT Bot needs a live full-access/default calling thread or a full-access client.";

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

export const layer = McpToolAccess.toLayer(
  ChannelToolkit,
  Effect.gen(function* () {
    const exporter = yield* ChannelTaskExport.ChannelTaskExport;
    return {
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
                : {
                    senderThreadId: scope.thread.threadId,
                    senderEnvironmentId: scope.environmentId,
                  }),
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
          return yield* gateway
            .ingest(message, mcpContextOf(scope))
            .pipe(Effect.mapError(failureFor));
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
      channel_task_export: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          return yield* exporter
            .exportTasks({ ...input, ownerId: yield* ownerIdOf })
            .pipe(Effect.mapError(failureFor));
        }),
      ),
      channel_task_move: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          if (!scope.grantedScopes?.includes("orchestration:operate")) {
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Moving work to another machine requires orchestration:operate.",
            });
          }
          const ledger = yield* ChannelLedger.ChannelLedger;
          const stored = yield* ledger.getTask(input.taskId).pipe(Effect.mapError(failureFor));
          if (stored === undefined || stored.ownerId !== channelOwnerIdFor(scope.environmentId)) {
            return yield* notFound();
          }
          const remoteWorkers = yield* ChannelRemoteWorkers.ChannelRemoteWorkers;
          const runtime = yield* ChannelRuntime.ChannelRuntime;
          return yield* remoteWorkers
            .move({
              ...input,
              actor: "agent",
              owner: runtime.ownerToken,
              // A thread caller's own runtime mode; an outside client's access level.
              callerCeiling: (yield* loadCaller()).limits.runtimeMode,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "ChannelTaskMoveError"
                  ? new OrchestratorMcpFailure({
                      code:
                        error.reason === "task_not_found" ? "task_not_found" : "invalid_request",
                      message: error.message,
                    })
                  : failureFor(error),
              ),
            );
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
      channel_bot_home: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const home = yield* ChannelBotHome.ChannelBotHome;
          return yield* home.read.pipe(Effect.mapError(failureFor));
        }),
      ),
      // Agents never hold settings:write, so the environment-write gate decides, as for
      // goat_connection_add_ssh: a full-access caller can already edit settings itself.
      channel_bot_home_claim: McpToolAccess.writesEnvironment(
        (input, check) =>
          Effect.gen(function* () {
            const services = yield* Effect.context<Effect.Services<typeof check>>();
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const home = yield* ChannelBotHome.ChannelBotHome;
            // Inside the settings lock: the caller must still have full access and, when it
            // holds a credential, that credential must still be live.
            const stillAllowed = check.pipe(
              Effect.andThen(Effect.suspend(() => scope.reauthorize?.([]) ?? Effect.void)),
              Effect.provideContext(services),
            );
            yield* stillAllowed.pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "capability_denied",
                    message: HOME_CLAIM_DENIAL,
                  }),
              ),
            );
            yield* McpToolAccess.admit(input);
            return yield* home
              .claimHere(
                stillAllowed.pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    () =>
                      new ServerSettingsError({
                        settingsPath: HOME_CLAIM_REVOKED,
                        operation: "normalize",
                      }),
                  ),
                ),
              )
              .pipe(
                Effect.mapError((error) =>
                  error.settingsPath === HOME_CLAIM_REVOKED
                    ? new OrchestratorMcpFailure({
                        code: "capability_denied",
                        message: HOME_CLAIM_DENIAL,
                      })
                    : new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: "Could not save GOAT Bot's home on this machine.",
                      }),
                ),
              );
          }),
        { admission: "handler" },
      ),
    } satisfies McpToolAccess.Handlers<typeof ChannelToolkit.tools>;
  }),
);
