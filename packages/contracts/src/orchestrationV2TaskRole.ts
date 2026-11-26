import * as Schema from "effect/Schema";

export const OrchestrationV2TaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestrationV2TaskRole = typeof OrchestrationV2TaskRole.Type;
