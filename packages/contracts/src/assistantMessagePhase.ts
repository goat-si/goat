import * as Schema from "effect/Schema";

/** What a provider says an assistant message is; only Codex reports it. */
export const AssistantMessagePhase = Schema.Literals([
  "commentary",
  "partial_answer",
  "final_answer",
]);
export type AssistantMessagePhase = typeof AssistantMessagePhase.Type;
