import type { CuaDriverMcpConfiguration, ThreadId } from "@goat/contracts";
import { isGoatBotSessionThreadId } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as Schema from "effect/Schema";
import { codexNativeSubagentConfig } from "./CodexNativeSubagentConfig.ts";
import { codexThreadMcpEnvironment } from "./CodexThreadEnvironment.ts";
import { codexManagedCuaDriver } from "./CodexTurnSkills.ts";
import { codexGoatServerConfig } from "./goatCodexMcpServers.ts";
import { goatMemoryToolsWithout } from "./goatMcpToolNames.ts";

/**
 * Codex waits this long for MCP servers before the first model request and
 *   leaves out any server still starting (default 1 s, too short for cold
 *   `npx`/`uvx` servers).
 */
export const CODEX_THREAD_CONFIG = {
  ...codexThreadMcpEnvironment(undefined),
  "tools.update_plan.enabled": true,
  mcp_optional_startup_grace_ms: 10_000,
  // Codex applies concurrent summaries only to its built-in provider and sends whole sections.
  "features.concurrent_reasoning_summaries": true,
} as const;

// Keep Codex MCP calls longer than GOAT's hour-long wait tools.
const CODEX_GOAT_MCP_TOOL_TIMEOUT_SEC = 65 * 60;

export function codexThreadRuntimeParams(input: {
  readonly mcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
  readonly threadId?: ThreadId;
  readonly stdioEnvironment?: Readonly<Record<string, string>>;
  readonly modelSelection?: { readonly model: string };
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  /** From `initialize`; unknown omits the subagent keys older Codex rejects. */
  readonly codexVersion?: string | undefined;
  /** The user's Codex config already defines `cua-driver`; theirs wins unless overridden. */
  readonly userCuaDriver?: boolean;
  /** A managed driver an earlier config attached to this live thread; disabled when dropped. */
  readonly previousCuaDriver?: CuaDriverMcpConfiguration | undefined;
}): {
  readonly cwd?: string;
  readonly model?: string;
  readonly config: Readonly<Record<string, Schema.Json>>;
} {
  const { mcpSession } = input;
  const memory = McpProviderSession.memoryToolAvailability(mcpSession);
  const disabledMemoryTools = goatMemoryToolsWithout(memory);
  const cuaDriver = codexManagedCuaDriver(mcpSession, input.userCuaDriver === true);
  // Disable the entire dotted cua-driver entry for unattended work without a lease.
  const cuaServer =
    cuaDriver !== undefined
      ? McpProviderSession.cuaCodexMcpServer(cuaDriver)
      : input.previousCuaDriver !== undefined
        ? { ...McpProviderSession.cuaCodexMcpServer(input.previousCuaDriver), enabled: false }
        : mcpSession?.cuaDriverBlocked === true
          ? {
              command: McpProviderSession.BLOCKED_CUA_STDIO_SERVER.command,
              args: [...McpProviderSession.BLOCKED_CUA_STDIO_SERVER.args],
              env: { ...McpProviderSession.BLOCKED_CUA_STDIO_SERVER.env },
              enabled: false,
            }
          : undefined;
  return {
    ...(input.runtimePolicy?.cwd == null ? {} : { cwd: input.runtimePolicy.cwd }),
    ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
    config: {
      ...CODEX_THREAD_CONFIG,
      ...(isGoatBotSessionThreadId(input.threadId ?? mcpSession?.threadId ?? "")
        ? // The owner's hooks would steer a bot turn into running their own tools. Only this
          // Codex session drops them: threads it launches, Claude sessions and text already in a
          // session keep theirs, which the personal data rule in the brief covers.
          { "features.default_mode_request_user_input": false, "features.hooks": false }
        : {}),
      ...codexThreadMcpEnvironment(mcpSession),
      ...(input.threadId === undefined
        ? {}
        : {
            "shell_environment_policy.set.GOAT_THREAD_ID": input.threadId,
            "shell_environment_policy.set.T3CODE_THREAD_ID": input.threadId, // goat-rename: legacy
          }),
      ...input.stdioEnvironment,
      ...codexGoatServerConfig(mcpSession?.goatMcpServers, input.threadId),
      ...codexNativeSubagentConfig(mcpSession?.nativeSubagentLimit, input.codexVersion).config,
      ...(mcpSession === undefined
        ? {}
        : {
            // Override only GOAT's server so launch-argument MCP servers survive.
            "mcp_servers.goat": {
              url: mcpSession.endpoint,
              disabled_tools: [...disabledMemoryTools, "goat_thread_wait", "goat_task_create"],
              tool_timeout_sec: CODEX_GOAT_MCP_TOOL_TIMEOUT_SEC,
              http_headers: {
                Authorization: mcpSession.authorizationHeader,
              },
            },
            "mcp_servers.goat-direct": {
              url: mcpSession.endpoint,
              tool_timeout_sec: CODEX_GOAT_MCP_TOOL_TIMEOUT_SEC,
              http_headers: { Authorization: mcpSession.authorizationHeader },
              enabled_tools: ["goat_thread_wait", "goat_task_create"],
              omit_tools_from: ["code_mode", "deferred"],
            },
            // A dotted override replaces only this cua-driver server.
            ...(cuaServer === undefined
              ? {}
              : { [`mcp_servers.${McpProviderSession.CUA_MCP_SERVER_NAME}`]: cuaServer }),
          }),
    },
  };
}
