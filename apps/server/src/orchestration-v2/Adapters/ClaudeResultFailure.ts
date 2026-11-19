import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2ProviderFailure, OrchestrationV2ProviderTurn } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as DateTime from "effect/DateTime";

/** Exclude CLI-internal "[ede_diagnostic] ..." telemetry from error banners. */
function resultUserFacingError(result: SDKResultMessage): string | undefined {
  const errors = "errors" in result && Array.isArray(result.errors) ? result.errors : [];
  if (result.subtype === "success" && !result.is_error) {
    return undefined;
  }
  return errors.find(
    (error): error is string => typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
  );
}

const CONTEXT_WINDOW_FULL_ERROR =
  "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";

function terminalResultError(
  reason: SDKResultMessage["terminal_reason"],
  failureHint?: string,
): string | undefined {
  switch (reason) {
    case "api_error":
      return failureHint ?? "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
      // blocking_limit also means context exhaustion; only rate-limit evidence sets the hint.
      return failureHint ?? CONTEXT_WINDOW_FULL_ERROR;
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long":
      return CONTEXT_WINDOW_FULL_ERROR;
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

function isOverloadedResult(result: SDKResultMessage): boolean {
  return result.subtype === "success" && result.api_error_status === 529;
}

export function terminalStatusFromResult(
  message: SDKResultMessage,
  failureHint?: string,
): Extract<
  OrchestrationV2ProviderTurn["status"],
  "completed" | "interrupted" | "failed" | "cancelled"
> {
  // Explicit abort reasons override success envelopes with is_error=false.
  if (
    message.terminal_reason === "aborted_tools" ||
    message.terminal_reason === "aborted_streaming"
  ) {
    return "interrupted";
  }
  if (message.subtype === "success") {
    // The SDK can report API failures as subtype "success" with is_error set.
    return isOverloadedResult(message) ||
      message.api_error_status === 429 ||
      terminalResultError(message.terminal_reason, failureHint) !== undefined ||
      (message.is_error && failureHint !== undefined)
      ? "failed"
      : "completed";
  }
  const errorText = message.errors.join("\n").toLowerCase();
  if (errorText.includes("interrupt")) {
    return "interrupted";
  }
  if (errorText.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

const PROXY_COOLDOWN_PREFIX = "API Error: Request rejected (429) · All credentials for model ";
const PROXY_COOLDOWN =
  /^API Error: Request rejected \(429\) · All credentials for model [^\s()]+ are cooling down \(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/;
const GATEWAY_COOLDOWN = /\(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/;

function gatewayCooldownResetAt(
  cooldown: RegExpExecArray | null,
  completedAt: DateTime.Utc,
): string | undefined {
  if (cooldown === null) return undefined;
  const seconds =
    Number(cooldown[1] ?? 0) * 3_600 + Number(cooldown[2] ?? 0) * 60 + Number(cooldown[3] ?? 0);
  const resetMs = DateTime.toEpochMillis(completedAt) + seconds * 1_000;
  return seconds > 0 && resetMs < 8.64e15
    ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
    : undefined;
}

export function providerFailureFromResult(
  message: SDKResultMessage,
  completedAt: DateTime.Utc,
  failureHint?: string,
  usageLimited = false,
): OrchestrationV2ProviderFailure | null {
  const gatewayResetAt =
    failureHint === undefined &&
    message.subtype === "success" &&
    message.is_error &&
    message.terminal_reason === "api_error" &&
    message.api_error_status === 503
      ? gatewayCooldownResetAt(
          /^API Error: 503 \[[^\]\r\n]+\] \[429\]: \{"type":"error","error":\{"type":"rate_limit_error",[^\r\n]*\} \(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/.exec(
            message.result,
          ),
          completedAt,
        )
      : undefined;
  if (gatewayResetAt !== undefined) {
    return makeProviderFailure({
      class: "usage_limit",
      message: "Claude API rate limit reached. Try again later.",
      code: "api_error_429",
      retryable: true,
      resetAt: gatewayResetAt,
    });
  }
  const failureClass =
    (message.subtype === "success" && message.api_error_status === 429) || usageLimited
      ? "usage_limit"
      : "provider_error";
  const listedError = resultUserFacingError(message);
  const apiErrorMessage =
    message.subtype === "success" &&
    message.terminal_reason === "api_error" &&
    message.result.trim().startsWith("API Error:")
      ? makeProviderFailure({ message: message.result }).message.slice(0, 500)
      : undefined;
  const structuredError = isOverloadedResult(message)
    ? "Claude API is overloaded (529). Try again shortly."
    : message.subtype === "success" && message.api_error_status === 429
      ? "Claude API rate limit reached. Try again later."
      : terminalResultError(message.terminal_reason, failureHint ?? apiErrorMessage);
  if (message.subtype !== "success") {
    return makeProviderFailure({
      message: listedError ?? structuredError ?? message.errors.join("\n"),
      code: message.subtype,
      class: failureClass,
    });
  }
  if (!message.is_error && structuredError === undefined) {
    return null;
  }
  const apiErrorStatus = message.api_error_status ?? null;
  // API-key sessions get no rate_limit_info, so a gateway's 429 carries its reset only as text.
  const resetAt =
    apiErrorStatus === 429 && message.result.startsWith("API Error:")
      ? gatewayCooldownResetAt(
          (message.result.startsWith(PROXY_COOLDOWN_PREFIX)
            ? PROXY_COOLDOWN
            : GATEWAY_COOLDOWN
          ).exec(message.result),
          completedAt,
        )
      : undefined;
  return makeProviderFailure({
    message: listedError ?? structuredError ?? failureHint ?? message.result,
    code:
      apiErrorStatus === null
        ? (message.terminal_reason ?? "sdk_result_error")
        : `api_error_${apiErrorStatus}`,
    class: failureClass,
    retryable: apiErrorStatus === 429 || apiErrorStatus === 529 ? true : null,
    resetAt: resetAt ?? null,
  });
}
