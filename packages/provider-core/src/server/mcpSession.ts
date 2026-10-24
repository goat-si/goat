// @effect-diagnostics nodeBuiltinImport:off -- adapters build spawn environments synchronously.
import { withLegacyEnvNames } from "@goat/contracts/legacyT3Names";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  AuthEnvironmentScope,
  CuaDriverMcpConfiguration,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";

export interface McpProviderSessionConfig {
  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Bumped when GOAT replaces this credential's authority under the same
   * token, so a config read before the change is recognizably stale.
   */
  readonly credentialGeneration?: number;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * Set only when the server's computer use decision attached the driver to
   * this thread. Adapters attach it as a stdio MCP server named `cua-driver`
   * and add the computer use instructions; a provider that cannot run a host
   * stdio server ignores it.
   */
  readonly cuaDriver?: CuaDriverMcpConfiguration;
  /**
   * The managed driver replaces a `cua-driver` server the user configured in
   * the provider's own config. Without it the user's server wins (Codex).
   */
  readonly cuaDriverOverridesUserConfig?: boolean;
  /**
   * An unattended turn without an approved lease. No `cua-driver` may run for it, including
   * one the user configured in the provider's own config; adapters that can switch a
   * user-defined server off do so.
   */
  readonly cuaDriverBlocked?: boolean;
  /**
   * How many provider-native subagents the thread's goatclaw profile lets run at once. Absent
   * while goatclaw is off, which leaves the provider's own limits in place.
   */
  readonly nativeSubagentLimit?: number;
}

/** Server name every provider sees for the managed Cua Driver. */
export const CUA_MCP_SERVER_NAME = "cua-driver";

/**
 * Takes the `cua-driver` name for a turn that must not have computer use, so a provider that
 * merges its own config with GOAT's by server name never starts a `cua-driver` the user
 * configured. It exits at once and offers no tools.
 */
export const BLOCKED_CUA_STDIO_SERVER = {
  command: process.execPath,
  args: ["-e", ""],
  env: { ELECTRON_RUN_AS_NODE: "1", GOAT_CUA_BLOCKED: "1" },
} as const;

export const isBlockedCuaServer = (server: unknown): boolean =>
  typeof server === "object" &&
  server !== null &&
  "env" in server &&
  typeof server.env === "object" &&
  server.env !== null &&
  "GOAT_CUA_BLOCKED" in server.env;

const cuaEnvironment = (descriptor: CuaDriverMcpConfiguration) =>
  Object.fromEntries(descriptor.environment.map(({ name, value }) => [name, value]));

/** Claude and Cursor SDK `mcpServers` entry for the session's Cua Driver, keyed by name. */
export function cuaStdioMcpServers(config: McpProviderSessionConfig | undefined) {
  const descriptor = config?.cuaDriver;
  return descriptor === undefined
    ? {}
    : {
        [CUA_MCP_SERVER_NAME]: {
          type: "stdio" as const,
          command: descriptor.command,
          args: [...descriptor.args],
          env: cuaEnvironment(descriptor),
        },
      };
}

/** ACP stdio `mcpServers` entry for the session's Cua Driver. */
export function cuaAcpMcpServers(config: McpProviderSessionConfig | undefined) {
  const descriptor = config?.cuaDriver;
  return descriptor === undefined
    ? []
    : [
        {
          name: CUA_MCP_SERVER_NAME,
          command: descriptor.command,
          args: [...descriptor.args],
          env: descriptor.environment.map(({ name, value }) => ({ name, value })),
        },
      ];
}

/** OpenCode `local` MCP config for the session's Cua Driver. */
export function cuaOpenCodeMcpConfig(descriptor: CuaDriverMcpConfiguration) {
  return {
    type: "local" as const,
    command: [descriptor.command, ...descriptor.args],
    environment: cuaEnvironment(descriptor),
  };
}

/** Codex `mcp_servers` entry for the session's Cua Driver. */
export function cuaCodexMcpServer(descriptor: CuaDriverMcpConfiguration) {
  return {
    command: descriptor.command,
    args: [...descriptor.args],
    env: cuaEnvironment(descriptor),
  };
}

/** Identity of one driver attachment; a new daemon generation changes it. */
export function cuaDriverKey(descriptor: CuaDriverMcpConfiguration | undefined): string {
  return descriptor === undefined
    ? ""
    : JSON.stringify([descriptor.command, descriptor.args, descriptor.socketPath ?? null]);
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/** Native tool claims are derived from the issued credential, never runtime mode. */
export interface MemoryToolAvailability {
  readonly read: boolean;
  readonly write: boolean;
  readonly source: boolean;
}

export function memoryToolAvailability(
  config: Pick<McpProviderSessionConfig, "grantedScopes"> | undefined,
): MemoryToolAvailability {
  const scopes = config?.grantedScopes ?? [];
  const read = scopes.includes("memory:read");
  return {
    read,
    write: read && scopes.includes("memory:write"),
    source: read && scopes.includes("orchestration:read"),
  };
}

/**
 * A thread's own temporary directory. Parallel agents on one machine otherwise share /tmp and
 * can pick up each other's scratch files (#1206). It sits under the server's temp directory so
 * provider sandboxes that allow the system temp directory allow it too.
 */
export function threadTemporaryDirectory(threadId: string): string {
  const key = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  const directory = NodePath.join(NodeOS.tmpdir(), `goat-thread-${key}`);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Empty markers prevent a thread shell from falling back to a broader stored login. */
export function withThreadMcpEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | (Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader"> &
        Partial<Pick<McpProviderSessionConfig, "threadId">>)
    | undefined,
): NodeJS.ProcessEnv {
  return withLegacyEnvNames({
    ...base,
    ...(config?.threadId === undefined
      ? {}
      : { TMPDIR: threadTemporaryDirectory(config.threadId) }),
    GOAT_ACP_MCP_ENDPOINT: config?.endpoint ?? "",
    GOAT_ACP_MCP_AUTHORIZATION: config?.authorizationHeader ?? "",
  });
}
