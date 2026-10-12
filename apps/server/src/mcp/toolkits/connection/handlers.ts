import {
  type ConnectionCatalogOperation,
  type ConnectionCatalogResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ConnectionCatalogBroker from "../../../connections/ConnectionCatalogBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ConnectionToolkit } from "./tools.ts";

const CATALOG_TIMEOUT_MS = 30_000;
const SSH_ADD_TIMEOUT_MS = 10 * 60_000;
const NO_HOST_MESSAGE =
  "No GOAT desktop app is serving saved connections for this environment. Saved connections belong to the desktop app that runs this environment as its main local environment: open it on this machine, or add the host in Settings → Connections → SSH. Web-only, mobile and desktop WSL-backend environments cannot save SSH connections through agents.";

const invoke = <const T extends ConnectionCatalogOperation["type"]>(
  operation: ConnectionCatalogOperation & { readonly type: T },
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    const result = yield* broker.invoke(operation, timeoutMs).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "host_unavailable",
            message:
              error._tag === "ConnectionCatalogHostUnavailable" ? NO_HOST_MESSAGE : error.message,
          }),
      ),
    );
    if (result.type === "failure") {
      return yield* new OrchestratorMcpFailure({
        code: result.reason === "connection_failed" ? "host_unavailable" : "invalid_request",
        message: Array.from(result.message).slice(0, 2000).join(""),
      });
    }
    if (result.type !== operation.type) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The desktop connection catalog returned a different operation's response.",
      });
    }
    // The runtime discriminant check above establishes the operation-specific result.
    return result as Extract<ConnectionCatalogResult, { readonly type: T }>;
  });

const callerIdentity = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.thread?.threadId ?? scope.client?.label ?? "unknown";

export const layer = McpToolAccess.toLayer(ConnectionToolkit, {
  goat_connection_list: McpToolAccess.reads(() =>
    invoke({ type: "list" }, CATALOG_TIMEOUT_MS).pipe(
      Effect.map((result) => ({ connections: [...result.connections] })),
    ),
  ),
  goat_connection_add_ssh: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("orchestration")) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot reach other machines.",
        });
      }
      const result = yield* invoke(
        {
          type: "add_ssh",
          host: input.host,
          ...(input.label === undefined ? {} : { label: input.label }),
          addedBy: {
            kind: "agent",
            ...(scope.thread === undefined ? {} : { threadId: scope.thread.threadId }),
            ...(scope.client === undefined ? {} : { client: scope.client.label }),
            at: DateTime.formatIso(yield* DateTime.now),
          },
        },
        SSH_ADD_TIMEOUT_MS,
      );
      yield* Effect.logInfo("Saved desktop SSH connection", {
        caller: callerIdentity(scope),
        host: input.host,
        created: result.created,
      });
      return { created: result.created, connection: result.connection };
    }),
  ),
  goat_connection_remove: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const result = yield* invoke(
        { type: "remove", environmentId: input.environmentId },
        CATALOG_TIMEOUT_MS,
      );
      yield* Effect.logInfo("Removed desktop connection", {
        caller: callerIdentity(scope),
        environmentId: input.environmentId,
      });
      return { removed: result.removed };
    }),
  ),
});
