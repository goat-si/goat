import {
  type HubNode,
  type HubNodesError,
  type SavedConnection,
  OrchestratorMcpFailure,
} from "@goat/contracts";

/** The pre-hub saved-connection shape agents already read; unidentified nodes have none. */
export const legacyConnection = (node: HubNode): SavedConnection | undefined =>
  node.environmentId === null
    ? undefined
    : {
        environmentId: node.environmentId,
        label: node.label,
        enabled: true,
        routes: node.routes.map(({ target }) => {
          switch (target.kind) {
            case "ssh":
              return {
                kind: "ssh",
                host: target.alias,
                hostname: target.hostname ?? target.alias,
                username: target.username,
                port: target.port,
              };
            case "linked":
              return { kind: "direct", httpBaseUrl: target.baseUrl };
            case "cloud":
              return {
                kind: "ssh",
                host: target.alias,
                hostname: target.alias,
                username: null,
                port: null,
              };
          }
        }),
        ...(node.addedBy?.kind === "agent"
          ? { addedBy: { ...node.addedBy, kind: "agent" as const } }
          : {}),
      };

export const hubNodesFailure = (error: HubNodesError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "host_unavailable"
        ? "host_unavailable"
        : error.reason === "storage_failed"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });
