import type {
  ActionOutcomeSafety,
  ScreenEffectReceipt,
  ScreenHostCall,
  ScreenRunError,
  ScreenRunResult,
} from "@goat/contracts";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";

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
    error.effectStarted === true || error.nextStep === undefined
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
