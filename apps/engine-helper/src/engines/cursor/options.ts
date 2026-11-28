import type { AgentOptions, McpServerConfig, ModelSelection as SdkModelSelection } from "@cursor/sdk";
import type { InitializeParams } from "../../protocol.ts";

// v1 sdkModel.ts:8-17, 90-125; explicit values are forwarded even without a catalog.
export function cursorSdkModelSelection(selection: InitializeParams["modelSelection"]): SdkModelSelection {
  const params = (selection.options ?? []).map((option) => ({
    id: ({ contextWindow: "context", fastMode: "fast" } as Record<string, string>)[option.id] ?? option.id,
    value: String(option.value),
  }));
  return { id: selection.model === "auto" ? "default" : selection.model, ...(params.length ? { params } : {}) };
}

// v1 agentOptions.ts:15-44, 46-65, 67-96, 105-141.
export function cursorMcpServers(params: InitializeParams): Record<string, McpServerConfig> | undefined {
  return params.mcp === null ? undefined : {
    goat: { type: "http", url: params.mcp.url, headers: { Authorization: `Bearer ${params.mcp.bearerToken}` } },
  };
}

export function makeCursorAgentOptions(params: InitializeParams, apiKey?: string): AgentOptions {
  const autoReview = params.runtimeMode === "approval-required" || params.runtimeMode === "auto";
  const sandboxEnabled = params.runtimeMode !== "full-access" && !(process.platform === "win32" && autoReview);
  const settingSources = ["user", "team", "mdm", "plugins"] as const;
  return {
    model: cursorSdkModelSelection(params.modelSelection),
    name: `GOAT ${params.threadId}`,
    mode: "agent",
    ...(apiKey === undefined ? {} : { apiKey }),
    local: {
      cwd: params.cwd,
      autoReview,
      settingSources: params.runtimeMode === "full-access" && !sandboxEnabled && !autoReview
        ? ["project", ...settingSources] : [...settingSources],
      sandboxOptions: { enabled: sandboxEnabled },
      enableAgentRetries: true,
    },
    ...(params.mcp === null ? {} : { mcpServers: cursorMcpServers(params)! }),
  };
}
