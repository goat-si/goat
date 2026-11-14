import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * launch arguments whose appended system prompt cannot be read, or MCP registration that never
 * answers while the query opens.
 */
export const CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL =
  "Claude provider query ended before the turn could start.";
const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

export const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (isProtocolError(error) &&
    error.driver === "claudeAgent" &&
    error.detail === CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));
