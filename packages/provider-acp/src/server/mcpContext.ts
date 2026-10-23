import type * as EffectAcpSchema from "effect-acp/compat";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { type SelfInvocation, selfInvocationArgs } from "@goat/shared/nodeRuntime";

export interface AcpMcpContext {
  readonly servers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly endpoint?: string;
  readonly authorization?: string;
  /** The session's activation lists the managed `cua-driver` server. */
  readonly computerUse?: boolean;
  /** Identity of that driver (`cuaDriverKey`), empty when the session has none. */
  readonly computerUseKey?: string;
}

export function acpMcpContext(
  session: McpProviderSession.McpProviderSessionConfig | undefined,
  self: SelfInvocation,
): AcpMcpContext {
  if (session === undefined) {
    return {
      servers: [],
      acpServers: [],
      processEnvironment: McpProviderSession.withThreadMcpEnvironment({}, undefined),
    };
  }
  // Agents that advertise optional http support still routinely fail to wire
  // injected http servers through to their backend (codex-acp 1.2.0 and pi-acp
  // both drop them), so every ACP session gets the `goat acp-mcp-bridge` stdio
  // server, which forwards JSON-RPC to GOAT's authenticated MCP endpoint. The
  // managed Cua Driver is already a stdio server, so it is listed in both
  // forms: an agent with MCP-over-ACP receives only `acpServers`.
  const cua = McpProviderSession.cuaAcpMcpServers(session);
  return {
    servers: [
      {
        name: "goat",
        command: self.command,
        args: [...selfInvocationArgs(self, ["acp-mcp-bridge"])],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "GOAT_ACP_MCP_ENDPOINT", value: session.endpoint },
          { name: "GOAT_ACP_MCP_AUTHORIZATION", value: session.authorizationHeader },
        ],
      },
      ...cua,
    ],
    acpServers: [{ type: "acp", name: "goat", serverId: "goat" }, ...cua],
    endpoint: session.endpoint,
    authorization: session.authorizationHeader,
    computerUse: cua.length > 0,
    computerUseKey: McpProviderSession.cuaDriverKey(session.cuaDriver),
    // Agent instructions and terminal fallbacks written for older builds read the legacy names.
    processEnvironment: McpProviderSession.withThreadMcpEnvironment(
      {
        GOAT_ACP_MCP_NODE: self.command,
        ...(self.entrypoint === undefined ? {} : { GOAT_ACP_MCP_ENTRYPOINT: self.entrypoint }),
      },
      session,
    ),
  };
}

export function acpMcpActivation(context: AcpMcpContext) {
  return { mcpServers: context.servers, acpMcpServers: context.acpServers };
}

export const acpMcpCredentialsMatch = (
  left: AcpMcpContext | undefined,
  right: AcpMcpContext,
): boolean => left?.authorization === right.authorization && left?.endpoint === right.endpoint;
