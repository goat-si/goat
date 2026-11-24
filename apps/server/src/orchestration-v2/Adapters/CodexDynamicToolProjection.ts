import { MCP_APP_RESOURCE_SCHEME } from "@goat/shared/mcpApp";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type { OrchestrationV2TurnItem } from "@goat/contracts";
import type { McpToolPresentation } from "../../provider/CodexToolPresentation.ts";

export interface CodexDynamicToolProjection extends McpToolPresentation {
  readonly toolName: string;
  readonly title?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly status: OrchestrationV2TurnItem["status"];
}

export type CodexDynamicToolItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "mcpToolCall" | "dynamicToolCall" }
>;

export function codexMcpAppResourceUri(item: CodexDynamicToolItem): string | undefined {
  if (item.type !== "mcpToolCall") return undefined;
  const uri = item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri ?? item.appContext?.resourceUri;
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}
