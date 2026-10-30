import type { AgentOptions, McpServerConfig, SettingSource } from "@cursor/sdk";
import type { ModelSelection, ThreadId } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

import { cursorSdkModelSelection } from "./sdkModel.ts";

export interface CursorRuntimeAgentPolicy {
  readonly autoReview: boolean;
  readonly sandboxEnabled: boolean;
}

export function cursorRuntimeAgentPolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  platform: NodeJS.Platform,
): CursorRuntimeAgentPolicy {
  const sandboxPolicyType =
    typeof runtimePolicy.sandboxPolicy === "object" &&
    runtimePolicy.sandboxPolicy !== null &&
    "type" in runtimePolicy.sandboxPolicy &&
    typeof runtimePolicy.sandboxPolicy.type === "string"
      ? runtimePolicy.sandboxPolicy.type
      : undefined;
  const autoReview =
    runtimePolicy.approvalPolicy === undefined
      ? runtimePolicy.runtimeMode === "approval-required" || runtimePolicy.runtimeMode === "auto"
      : runtimePolicy.approvalPolicy !== "never";
  return {
    autoReview,
    // The Windows SDK has no filesystem sandbox; omit the default only when
    // Auto-review still gates execution. Explicit policies remain authoritative.
    sandboxEnabled:
      runtimePolicy.sandboxPolicy === undefined
        ? runtimePolicy.runtimeMode !== "full-access" && !(platform === "win32" && autoReview)
        : sandboxPolicyType !== "dangerFullAccess",
  };
}

export function cursorMcpServers(
  session: McpProviderSession.McpProviderSessionConfig | undefined,
): Record<string, McpServerConfig> | undefined {
  if (session === undefined) {
    return undefined;
  }
  return {
    goat: {
      type: "http",
      url: session.endpoint,
      headers: {
        Authorization: session.authorizationHeader,
      },
    },
    ...McpProviderSession.cuaStdioMcpServers(session),
  };
}

/** The SDK loads no CLI settings unless `settingSources` is supplied. */
const CURSOR_AGENT_SETTING_SOURCES = [
  "project",
  "user",
  "team",
  "mdm",
  "plugins",
] as const satisfies ReadonlyArray<SettingSource>;

/**
 * Cursor can drop its `task` tool but has no concurrency cap, so a goatclaw limit of zero
 * switches native subagents off and any other limit leaves them uncapped.
 */
export const cursorSubagentsDisabled = (
  mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
) => mcpSession?.nativeSubagentLimit === 0;

export function makeCursorAgentOptions(input: {
  readonly apiKey?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly threadId: ThreadId;
  readonly mcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
  readonly platform: NodeJS.Platform;
}): AgentOptions {
  const policy = cursorRuntimeAgentPolicy(input.runtimePolicy, input.platform);
  const mcpServers = cursorMcpServers(input.mcpSession);
  return {
    model: cursorSdkModelSelection(input.modelSelection),
    name: `GOAT ${input.threadId}`,
    mode: input.runtimePolicy.interactionMode === "plan" ? "plan" : "agent",
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(cursorSubagentsDisabled(input.mcpSession) ? { disallowedTools: ["task"] } : {}),
    local: {
      ...(input.runtimePolicy.cwd === null ? {} : { cwd: input.runtimePolicy.cwd }),
      autoReview: policy.autoReview,
      settingSources: [...CURSOR_AGENT_SETTING_SOURCES],
      sandboxOptions: {
        enabled: policy.sandboxEnabled,
      },
      enableAgentRetries: true,
    },
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}
