import type {
  ActionOutcomeSafety,
  ScreenEffectReceipt,
  ScreenHostCall,
  ScreenRunError,
  ScreenRunResult,
  ScreenJournalEntry,
} from "@goat/contracts";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import { ScreenRunError as ScreenRunErrorSchema } from "@goat/contracts";
import * as Schema from "effect/Schema";
const isScreenRunError = Schema.is(ScreenRunErrorSchema);
import {
  mergeTerminal,
  terminalFailure,
  type ComputerUseTerminalReason,
} from "../cua/ComputerUseTerminal.ts";

const reads = new Set<ScreenHostCall["method"]>([
  "list_apps",
  "list_windows",
  "list_menu_bar_extras",
  "list_tabs",
  "bind_app",
  "select_tab",
  "observe",
  "tab_status",
  "read_page",
  "wait_for",
  "get_window_state",
  "get_accessibility_tree",
  "verify_state",
  "screenshot",
  "fetch_tab",
  "tab_logs",
]);

/** A call that only reads, which may still run after an earlier call in its cell failed. */
export const isScreenRead = (method: ScreenHostCall["method"]) => reads.has(method);

export const screenActionSafety = (
  call: Pick<ScreenHostCall, "method">,
  status: "completed" | "refused" | "partial" | "unapplied" | "indeterminate",
  dispatched: boolean,
  refusalCategory: "reobserve" | "terminal" = "terminal",
): ActionOutcomeSafety =>
  classifyActionOutcome({
    effect: reads.has(call.method) ? "read" : "write",
    status,
    dispatched,
    refusalCategory,
  });

export const screenFailureSafety = (call: ScreenHostCall, error: ScreenRunError) =>
  error.safety ??
  screenActionSafety(
    call,
    error.effectStarted ? "indeterminate" : "refused",
    error.effectStarted,
    error.code === "not_run" || error.code === "user_interacting" ? "reobserve" : "terminal",
  );

// What a refused call says of itself; true of that call only, never of the cell around it.
const UNSENT = /(?:[,;]|\s+and)\s*(?:so\s+)?nothing was sent(?=[.;,]|$)|\s*\bNothing was sent\./gi;

/**
 * The next step of a cell whose failing call sent nothing after an earlier call's input went out:
 * that input stands, and the cell has not seen what it did.
 */
const afterEarlierInput = (
  error: { readonly callId?: number; readonly nextStep?: string },
  receipts: readonly ScreenEffectReceipt[],
): string | undefined => {
  const failed = receipts.find((receipt) => receipt.callId === error.callId);
  const sent = receipts.findLast(
    (receipt) => receipt.safety?.possibleCommit === true && receipt.callId !== error.callId,
  );
  if (sent === undefined) return undefined;
  const input =
    sent.safety?.code === "write_committed"
      ? `Call ${sent.callId} (${sent.method}) was confirmed, so its input reached the target.`
      : `Call ${sent.callId} (${sent.method}) may have taken effect.`;
  const call =
    error.callId === undefined
      ? "A later call"
      : `Call ${error.callId}${failed === undefined ? "" : ` (${failed.method})`}`;
  const reason = (error.nextStep ?? "").replace(UNSENT, "").trim();
  const text = `${input} ${call} did not run, so this cell has not seen what that input did${
    reason.length > 0 ? `: ${reason}` : "."
  } Do not resend call ${sent.callId}; observe in a new cell first.`;
  return text.length <= 1024 ? text : `${text.slice(0, 1023)}…`;
};

/**
 * A cell's final error: when any of its calls may have committed, the cell as a whole may have,
 * so rerunning it would repeat that input. Pass every receipt, before any are cut for the reply.
 */
export const cellErrorSafety = <
  E extends {
    readonly safety?: ActionOutcomeSafety;
    readonly effectStarted?: boolean;
    readonly callId?: number;
    readonly code?: string;
    readonly nextStep?: string;
  },
>(
  error: E,
  receipts: readonly ScreenEffectReceipt[],
): E => {
  if (
    error.safety?.possibleCommit === true ||
    (error.effectStarted !== true && !receipts.some((receipt) => receipt.safety?.possibleCommit))
  )
    return error;
  const nextStep =
    error.effectStarted === true ||
    error.nextStep === undefined ||
    error.code === "stopped_by_person" ||
    error.code === "screen_locked"
      ? undefined
      : afterEarlierInput(error, receipts);
  return {
    ...error,
    safety: classifyActionOutcome({
      effect: "write",
      status: "indeterminate",
      dispatched: true,
    }),
    ...(nextStep === undefined ? {} : { nextStep }),
  };
};

export const cellTerminalError = (
  error: ScreenRunError,
  receipts: readonly ScreenEffectReceipt[],
  reason: ComputerUseTerminalReason | undefined,
): ScreenRunError => {
  const assessed = cellErrorSafety(error, receipts);
  const incoming =
    error.code === "stopped_by_person" || error.code === "screen_locked" ? error.code : undefined;
  const merged = mergeTerminal(
    { reason, possibleCommit: assessed.safety?.possibleCommit },
    {
      reason: incoming,
      possibleCommit: error.effectStarted || error.safety?.possibleCommit,
    },
  );
  const terminal = terminalFailure(
    merged.reason,
    merged.possibleCommit ? "click" : "list_apps",
    {},
    merged.possibleCommit,
  );
  if (terminal === undefined) return assessed;
  const safety =
    assessed.safety ??
    classifyActionOutcome({
      effect: merged.possibleCommit ? "write" : "read",
      status: merged.possibleCommit ? "indeterminate" : "refused",
      dispatched: merged.possibleCommit,
    });
  return {
    ...assessed,
    ...terminal,
    safety: {
      ...safety,
      possibleCommit: merged.possibleCommit,
      retryClass: "never",
    },
  };
};

export const latchCellTerminal = (
  cells: Map<string, ComputerUseTerminalReason>,
  id: string,
  reason: ComputerUseTerminalReason | undefined,
) => {
  const merged = mergeTerminal({ reason: cells.get(id) }, { reason }).reason;
  if (merged !== undefined) cells.set(id, merged);
};

export const completionCellError = (
  candidate: unknown,
  receipts: readonly ScreenEffectReceipt[],
  reason: ComputerUseTerminalReason | undefined,
): ScreenRunError | undefined => {
  const error = isScreenRunError(candidate) ? candidate : undefined;
  if (error === undefined && reason === undefined) return undefined;
  return cellTerminalError(
    error ?? {
      code: "stopped",
      effectStarted: false,
      nextStep: "Refresh the screen run and retry if appropriate.",
    },
    receipts,
    reason,
  );
};

export const appendCellNotices = (
  journal: readonly ScreenJournalEntry[],
  notices: readonly ScreenJournalEntry[],
) =>
  [
    ...journal,
    ...notices.map((entry, index) => ({ ...entry, sequence: journal.length + index + 1 })),
  ].slice(-64);

export const cellResultSafety = (result: ScreenRunResult): ScreenRunResult =>
  result.error === undefined
    ? result
    : {
        ...result,
        error: cellErrorSafety(
          result.error,
          result.journal.map((entry) => entry.receipt),
        ),
      };
