import * as Effect from "effect/Effect";
import { providerProcessExitGuidance } from "@goat/provider-core/server/failure";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

const CLAUDE_ROOT_REFUSAL =
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";
export const CLAUDE_CONVERSATION_NOT_FOUND = "No conversation found with session ID:";
export const MAX_CLAUDE_MISSING_NATIVE_THREADS = 1000;

export class ClaudeAgentSdkQueryRunnerError extends Schema.TaggedError<ClaudeAgentSdkQueryRunnerError>()(
  "ClaudeAgentSdkQueryRunnerError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Claude Agent SDK query failed.";
  }
}

export class ClaudeCodeRootRefusalError extends Schema.TaggedError<ClaudeCodeRootRefusalError>()(
  "ClaudeCodeRootRefusalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return `Claude Code exited before it started: ${CLAUDE_ROOT_REFUSAL}`;
  }
}

export class ClaudeConversationNotFoundError extends Schema.TaggedError<ClaudeConversationNotFoundError>()(
  "ClaudeConversationNotFoundError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Claude Code could not find this conversation to resume. Send the message again to continue in a new Claude session with this thread's history.";
  }
}

const isConversationNotFoundError = Schema.is(ClaudeConversationNotFoundError);

export function isClaudeConversationNotFound(
  cause: Cause.Cause<ClaudeAgentSdkQueryRunnerError>,
): boolean {
  const error = Cause.squash(cause);
  return isClaudeAgentSdkQueryRunnerError(error) && isConversationNotFoundError(error.cause);
}

export class ClaudeMcpRegistrationTimeoutError extends Schema.TaggedError<ClaudeMcpRegistrationTimeoutError>()(
  "ClaudeMcpRegistrationTimeoutError",
  { phase: Schema.Literals(["initialize", "setMcpServers"]) },
) {
  override get message(): string {
    return this.phase === "initialize"
      ? "Claude timed out while starting up. Retry the turn; if it keeps failing, check Claude and the server logs."
      : "Claude timed out while registering its MCP tools. Retry the turn; if it keeps failing, check Claude and the server logs.";
  }
}

export class ClaudeBackgroundWorkBlocksQueryReplacementError extends Schema.TaggedError<ClaudeBackgroundWorkBlocksQueryReplacementError>()(
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  {},
) {
  override get message(): string {
    return "Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish, or press Stop, then send the message again.";
  }
}

const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAgentSdkQueryRunnerError);
export const isClaudeMcpRegistrationTimeoutError = Schema.is(ClaudeMcpRegistrationTimeoutError);

export function queryRunnerError(cause: unknown, method: string): ClaudeAgentSdkQueryRunnerError {
  return isClaudeAgentSdkQueryRunnerError(cause)
    ? cause
    : new ClaudeAgentSdkQueryRunnerError({ cause, method });
}

export class ClaudeCodeStartupExitError extends Schema.TaggedError<ClaudeCodeStartupExitError>()(
  "ClaudeCodeStartupExitError",
  { status: Schema.String, guidance: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.status} before it started. ${this.guidance}`;
  }
}

const isClaudeCodeStartupExitError = Schema.is(ClaudeCodeStartupExitError);

const CLAUDE_PROCESS_EXIT_ERROR_CLASSES: ReadonlySet<unknown> = new Set([
  "process_killed_by_signal",
  "process_exited_nonzero",
]);

function claudeProcessExit(sdkError: unknown): { status: string; code: string } | undefined {
  if (typeof sdkError !== "object" || sdkError === null) return undefined;
  const { errorClass, telemetryMessage } = sdkError as Record<string, unknown>;
  return typeof errorClass === "string" &&
    CLAUDE_PROCESS_EXIT_ERROR_CLASSES.has(errorClass) &&
    typeof telemetryMessage === "string"
    ? { status: telemetryMessage, code: errorClass }
    : undefined;
}

// The SDK's exit Error appends Claude's stderr tail to `message`; `telemetryMessage` omits it.
export function claudeProcessExitFailure(
  cause: Cause.Cause<ClaudeAgentSdkQueryRunnerError>,
): { readonly message: string; readonly code: string } | undefined {
  const error = Cause.squash(cause);
  const nested = isClaudeAgentSdkQueryRunnerError(error) ? error.cause : error;
  const startup = isClaudeCodeStartupExitError(nested) ? nested : undefined;
  const exit = claudeProcessExit(startup?.cause ?? nested);
  return exit === undefined
    ? undefined
    : { message: startup?.message ?? `${exit.status}.`, code: exit.code };
}

export const claudeStreamFailure = Effect.fn("Claude.streamFailure")(function* (input: {
  cause: unknown;
  answered: boolean;
  conversationMissing: boolean;
  stderr: string;
  threadId: string;
}) {
  const { cause, answered, conversationMissing, stderr, threadId } = input;
  const startupExit = answered ? undefined : claudeProcessExit(cause);
  if (startupExit !== undefined)
    yield* Effect.logWarning("orchestration-v2.claude-startup-exit", {
      threadId,
      status: startupExit.status,
      stderr,
    });
  return queryRunnerError(
    !answered && stderr.includes(CLAUDE_ROOT_REFUSAL)
      ? new ClaudeCodeRootRefusalError({ cause })
      : conversationMissing || (!answered && stderr.includes(CLAUDE_CONVERSATION_NOT_FOUND))
        ? new ClaudeConversationNotFoundError({ cause })
        : startupExit !== undefined
          ? new ClaudeCodeStartupExitError({
              status: startupExit.status,
              guidance: providerProcessExitGuidance(stderr),
              cause,
            })
          : cause,
    "fromAsyncIterable",
  );
});
