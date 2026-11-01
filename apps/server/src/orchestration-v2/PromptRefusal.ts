import * as Predicate from "effect/Predicate";

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * launch arguments whose appended system prompt cannot be read, or MCP registration that never
 * answers while the query opens.
 */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

export const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));
