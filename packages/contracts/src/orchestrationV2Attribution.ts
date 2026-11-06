import * as Schema from "effect/Schema";

export const OrchestrationV2Actor = Schema.Literals(["user", "agent", "system"]);
export type OrchestrationV2Actor = typeof OrchestrationV2Actor.Type;

export const OrchestrationV2CreationSource = Schema.Literals([
  "web",
  "mobile",
  "mcp",
  "provider",
  "server",
]);
export type OrchestrationV2CreationSource = typeof OrchestrationV2CreationSource.Type;

export const OrchestrationV2ThreadHistoryOrigin = Schema.Literals(["native", "v1_import"]);
export type OrchestrationV2ThreadHistoryOrigin = typeof OrchestrationV2ThreadHistoryOrigin.Type;
