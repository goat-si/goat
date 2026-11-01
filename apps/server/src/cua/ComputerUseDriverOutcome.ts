// A native input error can follow an applied action (for example AX cannot-complete), so
// transport failure never proves that input was not sent.
// @effect-diagnostics preferSchemaOverJson:off
import {
  type ActionOutcomeSafety,
  ComputerUseRefusalDetail,
  UnappliedInputDiagnostic,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  classifyActionOutcome,
  classifyComputerUseActionOutcome,
} from "@goat/shared/actionOutcomeSafety";
import { actionResultFromDriver, PRE_DISPATCH_CODES } from "@goat/shared/computerUseActions";

import { isReadOnlyCall } from "./ComputerUseLeaseMessages.ts";

export { driverExitReason } from "./ComputerUseDriverExit.ts";

const STALL_CODE = "capture_backend_stalled";
// The driver's refusal once native capture is off (cua-driver platform-macos capture.rs).
const STALL_MESSAGE = /capture_backend_stalled: \d+ earlier native captures never completed/u;

/**
 * Whether a driver reply says its native screen capture is stuck until the driver restarts. Only
 * an error's code, reason or message counts: a window can show the word in its own text.
 */
export const captureStalled = (line: string): boolean => {
  if (!line.includes(STALL_CODE)) return false;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord(message)) return false;
  const error = isRecord(message.error) ? message.error : undefined;
  const result = isRecord(message.result) ? message.result : undefined;
  if (error === undefined && result?.isError !== true) return false;
  const structured = error?.data ?? result?.structuredContent;
  const fields = isRecord(structured) ? structured : {};
  if (fields.code === STALL_CODE) return true;
  const content = Array.isArray(result?.content) ? result.content : [];
  return [
    fields.reason,
    error?.message,
    ...content.map((block) => isRecord(block) && block.text),
  ].some((text) => typeof text === "string" && STALL_MESSAGE.test(text));
};

const UNVERIFIED_INPUT_NOTE =
  "GOAT: this input was already sent when the driver reported the error, so it may have acted. Do not resend it unchanged; observe the window before retrying.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The driver's own word that nothing went out, on refusals that carry no effect: bring_to_front's
 * pre-checks (activated and request_accepted false) and a paste kept out of browser chrome.
 */
const saysNotSent = (structured: Record<string, unknown>) =>
  structured.dispatched === false ||
  structured.delivered === false ||
  (structured.activated === false && structured.request_accepted === false);

const diagnostic = Schema.decodeUnknownOption(UnappliedInputDiagnostic);
const isRefusalDetail = Schema.is(ComputerUseRefusalDetail);

/** JSON-RPC errors a server raises before it runs anything: parse, request, method, params. */
const PRE_DISPATCH_RPC_ERRORS: ReadonlySet<unknown> = new Set([-32700, -32600, -32601, -32602]);
const POSSIBLE_COMMIT_DRIVER_CODES: ReadonlySet<unknown> = new Set([
  "tool_call_cancelled",
  "tool_call_abandoned",
  "tool_call_timeout",
]);

// A script's call log names tools without their arguments, so menu_bar_extras there may have acted.
const readTool = (tool: unknown) => isReadOnlyCall(tool);

/**
 * Whether a run_script reply's call log shows it sent no input: every driver call it lists is a
 * read. A call cut off by the script's wall time ("timeout") or a log that left calls out may
 * have sent some, and a reply without a log says nothing.
 */
const scriptSentNothing = (structured: Record<string, unknown>): boolean =>
  Array.isArray(structured.calls) &&
  structured.calls.every(
    (call: unknown) =>
      isRecord(call) &&
      call.code !== "timeout" &&
      call.driver_calls_omitted == null &&
      (call.tool == null || readTool(call.tool)) &&
      Array.isArray(call.driver_calls) &&
      call.driver_calls.every((each: unknown) => isRecord(each) && readTool(each.tool)),
  );

/** The safety a reply already carries, as GOAT marked it on an earlier pass. */
const markedSafety = (message: unknown): unknown => {
  const envelope = isRecord(message) ? message : {};
  if (isRecord(envelope.error))
    return isRecord(envelope.error.data) ? envelope.error.data.safety : undefined;
  const result = isRecord(envelope.result) ? envelope.result : {};
  return isRecord(result.structuredContent) ? result.structuredContent.safety : undefined;
};

/** A write's outcome safety; a reply already marked as possibly committed keeps that mark. */
export function driverOutcomeSafety(
  tool: string | undefined,
  message: unknown,
  args?: unknown,
): ActionOutcomeSafety {
  const safety = classifiedSafety(tool, message, args);
  const marked = markedSafety(message);
  return !safety.possibleCommit &&
    !isReadOnlyCall(tool, args) &&
    isRecord(marked) &&
    marked.possibleCommit === true
    ? classifyActionOutcome({ effect: "write", status: "indeterminate", dispatched: true })
    : safety;
}

function classifiedSafety(
  tool: string | undefined,
  message: unknown,
  args?: unknown,
): ActionOutcomeSafety {
  const envelope = isRecord(message) ? message : {};
  const result = isRecord(envelope.result) ? envelope.result : {};
  const error = isRecord(envelope.error) ? envelope.error : undefined;
  const raw = error
    ? isRecord(error.data)
      ? error.data
      : {}
    : isRecord(result.structuredContent)
      ? result.structuredContent
      : {};
  // The lease proxy's rule: an explicit effect outranks a refused status.
  const { status: _status, ...withoutStatus } = raw;
  const structured = raw.effect !== undefined && raw.status === "refused" ? withoutStatus : raw;
  const effect =
    isReadOnlyCall(tool, args) || (tool === "run_script" && scriptSentNothing(structured))
      ? "read"
      : "write";
  // GOAT's own refusal (ComputerUseLeaseResponses refusal) names its detail and sent nothing.
  if (
    isRefusalDetail(structured.detail) &&
    structured.refused !== undefined &&
    (structured.effect === undefined || structured.effect === "refused") &&
    (envelope.status === "not_started" || error !== undefined || result.isError === true)
  )
    return refusalSafety(structured.detail, tool, args);
  if (envelope.status === "not_started")
    return classifyActionOutcome({ effect, status: "refused", dispatched: false });
  const failed =
    error !== undefined || result.isError === true || envelope.status === "unknown_outcome";
  const refusalCode = isRecord(structured.refusal) ? structured.refusal.code : structured.code;
  if (
    (refusalCode === "screen_locked" ||
      refusalCode === "user_interacting" ||
      refusalCode === "desktop_busy" ||
      refusalCode === "desktop_lease_unavailable") &&
    (structured.effect === undefined || structured.effect === "refused") &&
    (failed || structured.effect === "refused" || structured.status === "refused")
  )
    return classifyActionOutcome({
      effect,
      status: "refused",
      dispatched: false,
      refusalCategory: refusalCode === "screen_locked" ? "terminal" : "reobserve",
    });
  if (effect === "read" && !failed) return classifyActionOutcome({ effect, status: "completed" });
  const code = structured.code;
  if (structured.effect === "unknown" || POSSIBLE_COMMIT_DRIVER_CODES.has(code))
    return classifyActionOutcome({
      effect,
      status: code === "tool_call_timeout" ? "timed_out" : "indeterminate",
      dispatched: true,
    });
  // The driver's own word that nothing went out, without an effect to outrank it.
  if (structured.effect === undefined && saysNotSent(structured))
    return classifyActionOutcome({
      effect,
      status: "refused",
      dispatched: false,
      refusalCategory: "reobserve",
    });
  if (
    error !== undefined &&
    structured.effect === undefined &&
    PRE_DISPATCH_RPC_ERRORS.has(error.code)
  )
    return classifyActionOutcome({
      effect,
      status: "refused",
      dispatched: false,
      refusalCategory: "fix_input",
    });
  const unapplied = diagnostic(structured.unappliedInput);
  return classifyComputerUseActionOutcome(
    actionResultFromDriver(
      { delivery: "background" },
      {
        isError: failed,
        text: "",
        structured,
      },
    ),
    { effect, ...(unapplied._tag === "Some" ? { unappliedInput: unapplied.value } : {}) },
  );
}

/** Whether the driver refused a write before sending any of it, so it never reached the app. */
export const driverRefused = (
  tool: string | undefined,
  message: unknown,
  args?: unknown,
): boolean => driverOutcomeSafety(tool, message, args).code.startsWith("write_refused_");

/**
 * The driver's reply with GOAT's outcome safety, and with effect "unverifiable" added when an
 * input error may have acted. A success without structuredContent gets the safety as a text block:
 * Codex shows the model a non-null structuredContent in place of every content block
 * (ComputerUseDriverReply.ts), so adding one would hide the driver's text.
 */
export function markUnverified(tool: string | undefined, line: string, args?: unknown): string {
  if (tool === undefined) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(message)) return line;
  const read = isReadOnlyCall(tool, args);
  const safety = driverOutcomeSafety(tool, message, args);
  if (isRecord(message.error)) {
    const raw = message.error.data;
    const data = raw === undefined ? {} : isRecord(raw) ? raw : { driverData: raw };
    const note = !read && safety.possibleCommit && typeof message.error.message === "string";
    return JSON.stringify({
      ...message,
      error: {
        ...message.error,
        ...(note ? { message: message.error.message + " " + UNVERIFIED_INPUT_NOTE } : {}),
        data: { ...data, safety },
      },
    });
  }
  if (!isRecord(message.result)) return line;
  const result = message.result;
  const content = Array.isArray(result.content) ? result.content : [];
  const isError = result.isError === true;
  if (!isRecord(result.structuredContent) && (read || !isError)) {
    if (read) return line;
    return JSON.stringify({
      ...message,
      result: {
        ...result,
        content: [
          ...content,
          { type: "text", text: "GOAT outcome: " + JSON.stringify({ safety }) },
        ],
      },
    });
  }
  const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
  const code = structured.code;
  const warn = !read && isError && safety.possibleCommit;
  const mark =
    warn &&
    structured.effect === undefined &&
    structured.status !== "refused" &&
    !(typeof code === "string" && PRE_DISPATCH_CODES.has(code));
  return JSON.stringify({
    ...message,
    result: {
      ...result,
      ...(warn ? { content: [...content, { type: "text", text: UNVERIFIED_INPUT_NOTE }] } : {}),
      structuredContent: { ...structured, ...(mark ? { effect: "unverifiable" } : {}), safety },
    },
  });
}

type RefusalCategory = "transient" | "reobserve" | "fix_input" | "terminal";

/** What a GOAT refusal asks the agent to do next; unlisted details wait for a person or GOAT. */
const REFUSAL_CATEGORY: Partial<Record<ComputerUseRefusalDetail, RefusalCategory>> = {
  target_busy: "reobserve",
  app_busy: "reobserve",
  invalid_target: "reobserve",
  wrong_display: "reobserve",
  app_not_approved: "reobserve",
  capture_hide_unconfirmed: "transient",
  foreground_not_approved: "fix_input",
  desktop_capture_off: "fix_input",
  screen_shared: "fix_input",
  token_first: "fix_input",
  pointer_locked: "fix_input",
};

/** A call GOAT refused before it reached the driver: nothing was sent. */
export const refusalSafety = (
  detail: ComputerUseRefusalDetail,
  tool?: string,
  args?: unknown,
): ActionOutcomeSafety =>
  classifyActionOutcome({
    effect: isReadOnlyCall(tool, args) ? "read" : "write",
    status: "refused",
    dispatched: false,
    refusalCategory: REFUSAL_CATEGORY[detail] ?? "terminal",
  });
