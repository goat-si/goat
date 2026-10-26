import { describe, expect, it } from "@effect/vitest";

import {
  classifyActionOutcome,
  classifyBrowserActionOutcome,
  classifyComputerUseActionOutcome,
  isSafeToAutoRetry,
} from "./actionOutcomeSafety.ts";

describe("actionOutcomeSafety", () => {
  it("keeps possibleCommit false across all read outcomes and allows auto-retry only on transient read failures", () => {
    const completed = classifyActionOutcome({ effect: "read", status: "completed" });
    expect(completed).toEqual({
      possibleCommit: false,
      retryClass: "never",
      writeStatus: "not_applicable",
      code: "read_completed",
    });
    expect(isSafeToAutoRetry(completed)).toBe(false);

    const timedOut = classifyBrowserActionOutcome({
      operation: "snapshot",
      status: "failed",
      errorTag: "PreviewAutomationTimeoutError",
    });
    expect(timedOut).toEqual({
      possibleCommit: false,
      retryClass: "same_key",
      writeStatus: "not_applicable",
      code: "read_timed_out",
    });
    expect(isSafeToAutoRetry(timedOut)).toBe(true);

    const invalidSelector = classifyBrowserActionOutcome({
      operation: "waitFor",
      status: "failed",
      errorTag: "PreviewAutomationInvalidSelectorError",
    });
    expect(invalidSelector).toEqual({
      possibleCommit: false,
      retryClass: "fix_input",
      writeStatus: "not_applicable",
      code: "read_failed_pre_dispatch",
    });
    expect(isSafeToAutoRetry(invalidSelector)).toBe(false);
  });

  it("marks confirmed writes as committed with retryClass never", () => {
    const cuConfirmed = classifyComputerUseActionOutcome({
      outcome: "confirmed",
      dispatch: "verified",
      delivery: "background",
    });
    expect(cuConfirmed).toEqual({
      possibleCommit: true,
      retryClass: "never",
      writeStatus: "committed",
      code: "write_committed",
    });
    expect(isSafeToAutoRetry(cuConfirmed)).toBe(false);

    const browserConfirmed = classifyBrowserActionOutcome({
      operation: "click",
      status: "completed",
    });
    expect(browserConfirmed).toEqual({
      possibleCommit: true,
      retryClass: "never",
      writeStatus: "committed",
      code: "write_committed",
    });
  });

  it("classifies suspected_noop and unapplied field values as rejected_before_commit with fix_input", () => {
    const noop = classifyComputerUseActionOutcome(
      {
        outcome: "suspected_noop",
        dispatch: "verified",
        delivery: "background",
      },
      {
        unappliedInput: {
          field: "  quantity  ",
          requested: "5",
          applied: "1",
          step: " fillOrder ",
          siteMessage: " Maximum allowed is 1 ",
        },
      },
    );
    expect(noop).toEqual({
      possibleCommit: false,
      retryClass: "fix_input",
      writeStatus: "rejected_before_commit",
      code: "write_unapplied",
      unappliedInput: {
        field: "quantity",
        requested: "5",
        applied: "1",
        step: "fillOrder",
        siteMessage: "Maximum allowed is 1",
      },
    });
    expect(isSafeToAutoRetry(noop)).toBe(false);

    const browserUnapplied = classifyBrowserActionOutcome({
      operation: "select",
      status: "completed",
      unappliedInput: {
        field: "country",
        requested: "KR",
        applied: "US",
      },
    });
    expect(browserUnapplied.possibleCommit).toBe(false);
    expect(browserUnapplied.retryClass).toBe("fix_input");
    expect(browserUnapplied.writeStatus).toBe("rejected_before_commit");
    expect(browserUnapplied.code).toBe("write_unapplied");
  });

  it("routes pre-dispatch refusals to transient, reobserve, fix_input, or terminal retry classes with possibleCommit false", () => {
    const busy = classifyComputerUseActionOutcome({
      outcome: "refused",
      reason: "busy",
      message: "Another call is running.",
    });
    expect(busy).toEqual({
      possibleCommit: false,
      retryClass: "same_key",
      writeStatus: "not_started",
      code: "write_refused_transient",
    });
    expect(isSafeToAutoRetry(busy)).toBe(true);

    const stale = classifyComputerUseActionOutcome({
      outcome: "refused",
      reason: "staleElement",
      message: "Element token expired.",
    });
    expect(stale).toEqual({
      possibleCommit: false,
      retryClass: "new_key",
      writeStatus: "not_started",
      code: "write_refused_reobserve",
    });
    expect(isSafeToAutoRetry(stale)).toBe(false);

    const bgUnavailable = classifyComputerUseActionOutcome({
      outcome: "refused",
      reason: "backgroundUnavailable",
      message: "Requires foreground delivery.",
    });
    expect(bgUnavailable).toEqual({
      possibleCommit: false,
      retryClass: "fix_input",
      writeStatus: "rejected_before_commit",
      code: "write_refused_fix_input",
    });

    const locked = classifyComputerUseActionOutcome({
      outcome: "refused",
      reason: "screenLocked",
      message: "Host screen is locked.",
    });
    expect(locked).toEqual({
      possibleCommit: false,
      retryClass: "never",
      writeStatus: "not_started",
      code: "write_refused_terminal",
    });
  });

  it("fails closed with possibleCommit true and retryClass never when a write times out, partially applies, or is cut after dispatch", () => {
    const partial = classifyComputerUseActionOutcome({
      outcome: "partial",
      dispatch: "dispatched_unknown",
      delivery: "background",
    });
    expect(partial).toEqual({
      possibleCommit: true,
      retryClass: "never",
      writeStatus: "may_have_applied",
      code: "write_partial",
    });

    const deadlineExceeded = classifyComputerUseActionOutcome({
      outcome: "unverifiable",
      dispatch: "dispatched_unknown",
      delivery: "background",
      detail: "Action exceeded its 15000ms deadline.",
    });
    expect(deadlineExceeded).toEqual({
      possibleCommit: true,
      retryClass: "never",
      writeStatus: "may_have_applied",
      code: "write_timed_out",
    });

    const postGateCut = classifyBrowserActionOutcome({
      operation: "type",
      status: "failed",
      errorTag: "PreviewAutomationControlInterruptedError",
      controlReason: "privateMode",
      dispatched: true,
    });
    expect(postGateCut).toEqual({
      possibleCommit: true,
      retryClass: "never",
      writeStatus: "may_have_applied",
      code: "write_indeterminate",
    });

    const preGateCut = classifyBrowserActionOutcome({
      operation: "type",
      status: "failed",
      errorTag: "PreviewAutomationControlInterruptedError",
      controlReason: "dialogPending",
      dispatched: false,
    });
    expect(preGateCut).toEqual({
      possibleCommit: false,
      retryClass: "fix_input",
      writeStatus: "rejected_before_commit",
      code: "write_refused_fix_input",
    });
  });
});
