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
    // An earlier call stopped the cell: observe again and issue a fresh call.
    error.code === "not_run" ? "reobserve" : "terminal",
  );

/**
 * A cell's final error: when any of its calls may have committed, the cell as a whole may have,
 * so rerunning it would repeat that input. Pass every receipt, before any are cut for the reply.
 */
export const cellErrorSafety = <
  E extends { readonly safety?: ActionOutcomeSafety; readonly effectStarted?: boolean },
>(
  error: E,
  receipts: readonly ScreenEffectReceipt[],
): E =>
  error.safety?.possibleCommit !== true &&
  (error.effectStarted === true || receipts.some((receipt) => receipt.safety?.possibleCommit))
    ? {
        ...error,
        safety: classifyActionOutcome({
          effect: "write",
          status: "indeterminate",
          dispatched: true,
        }),
      }
    : error;

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
