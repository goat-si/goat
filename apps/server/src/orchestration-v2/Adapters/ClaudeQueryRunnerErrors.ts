import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

export const CLAUDE_ROOT_REFUSAL =
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

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

const CLAUDE_PROCESS_EXIT_ERROR_CLASSES: ReadonlySet<unknown> = new Set([
  "process_killed_by_signal",
  "process_exited_nonzero",
]);

// The SDK's exit Error appends Claude's stderr tail to `message`; `telemetryMessage` omits it.
export function claudeProcessExitFailure(
  cause: Cause.Cause<ClaudeAgentSdkQueryRunnerError>,
): { readonly message: string; readonly code: string } | undefined {
  const error = Cause.squash(cause);
  const sdkError = isClaudeAgentSdkQueryRunnerError(error) ? error.cause : error;
  if (typeof sdkError !== "object" || sdkError === null) return undefined;
  const { errorClass, telemetryMessage } = sdkError as Record<string, unknown>;
  return typeof errorClass === "string" &&
    CLAUDE_PROCESS_EXIT_ERROR_CLASSES.has(errorClass) &&
    typeof telemetryMessage === "string"
    ? { message: `${telemetryMessage}.`, code: errorClass }
    : undefined;
}
