import { markUnverified } from "../cua/ComputerUseDriverOutcome.ts";
import { describe, expect, it } from "@effect/vitest";
import type { PreviewAutomationControlReason } from "@goat/contracts";

import {
  classifyActionOutcome,
  classifyComputerUseActionOutcome,
  isSafeToAutoRetry,
} from "@goat/shared/actionOutcomeSafety";
import { classifyBrowserActionOutcome } from "./actionOutcomeSafety.ts";

describe("actionOutcomeSafety", () => {
  it("reports a blocked host as a terminal refusal before input", () => {
    expect(
      classifyBrowserActionOutcome({
        operation: "navigate",
        status: "failed",
        errorTag: "PreviewAutomationControlInterruptedError",
        controlReason: "blocked_url",
      }),
    ).toMatchObject({ possibleCommit: false, retryClass: "never" });
  });
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

  it("keeps sent suspected_noop uncertain even with local value readback, while browser rejection stays unapplied", () => {
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
      possibleCommit: true,
      retryClass: "never",
      writeStatus: "may_have_applied",
      code: "write_indeterminate",
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

  it("a write that went out is never unapplied, even with an unapplied diagnostic; one that did not stays rejected", () => {
    const diagnostic = { field: "value", requested: "a", applied: "b" };
    for (const unappliedInput of [undefined, diagnostic])
      expect(
        classifyActionOutcome({
          effect: "write",
          status: "unapplied",
          dispatched: true,
          unappliedInput,
        }),
      ).toMatchObject({
        possibleCommit: true,
        retryClass: "never",
        writeStatus: "may_have_applied",
        code: "write_indeterminate",
      });
    for (const dispatched of [false, undefined])
      expect(
        classifyActionOutcome({ effect: "write", status: "unapplied", dispatched }),
      ).toMatchObject({
        possibleCommit: false,
        writeStatus: "rejected_before_commit",
        code: "write_unapplied",
      });
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

  it("fetch is a read: it never commits, and a timed-out fetch may be sent again", () => {
    expect(classifyBrowserActionOutcome({ operation: "fetch", status: "completed" })).toMatchObject(
      {
        possibleCommit: false,
        writeStatus: "not_applicable",
      },
    );
    expect(
      classifyBrowserActionOutcome({
        operation: "fetch",
        status: "failed",
        errorTag: "PreviewAutomationTimeoutError",
      }),
    ).toMatchObject({ possibleCommit: false, retryClass: "same_key" });
  });

  it("an execution error GOAT raised before any input left sent nothing", () => {
    expect(
      classifyBrowserActionOutcome({
        operation: "fillSecret",
        status: "failed",
        errorTag: "PreviewAutomationExecutionError",
        dispatched: false,
      }),
    ).toMatchObject({ possibleCommit: false, retryClass: "fix_input" });
    expect(
      classifyBrowserActionOutcome({
        operation: "fillSecret",
        status: "failed",
        errorTag: "PreviewAutomationExecutionError",
      }).possibleCommit,
    ).toBe(true);
  });

  it("an admission refusal sent nothing even without gate evidence; another interruption may have", () => {
    const interrupted = (controlReason: PreviewAutomationControlReason) =>
      classifyBrowserActionOutcome({
        operation: "click",
        status: "failed",
        errorTag: "PreviewAutomationControlInterruptedError",
        controlReason,
      }).possibleCommit;
    for (const reason of ["agentMismatch", "dialogPending", "tabRequired", "tabLimit"] as const)
      expect(interrupted(reason)).toBe(false);
    for (const reason of ["stopped", "humanControl", "privateMode", "interrupted"] as const)
      expect(interrupted(reason)).toBe(true);
  });
});

it("preview and native emitted outcomes use the same safety contract", () => {
  const native = JSON.parse(
    markUnverified(
      "click",
      JSON.stringify({ result: { structuredContent: { effect: "confirmed" } } }),
    ),
  );
  expect(native.result.structuredContent.safety).toEqual(
    classifyBrowserActionOutcome({ operation: "click", status: "completed" }),
  );
  const unknown = JSON.parse(
    markUnverified(
      "click",
      JSON.stringify({ error: { code: -32000, data: { code: "tool_call_cancelled" } } }),
    ),
  );
  expect(unknown.error.data.safety).toEqual(
    classifyBrowserActionOutcome({
      operation: "click",
      status: "failed",
      errorTag: "PreviewAutomationExecutionError",
    }),
  );
});
