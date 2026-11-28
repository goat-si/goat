import { expect, it } from "@effect/vitest";
import {
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { actionErrorContext } from "./PreviewTargetHost.testkit.ts";
import { previewActionFailure } from "./PreviewTargetFailures.ts";

it.effect("preserves blocked_url and its dispatch status for a navigation", () =>
  Effect.sync(() => {
    for (const dispatched of [false, true]) {
      const error = new PreviewAutomationControlInterruptedError({
        ...actionErrorContext,
        operation: "navigate",
        reason: "blocked_url",
        dispatched,
      });
      expect(previewActionFailure(error, "navigate")).toMatchObject({
        code: "blocked_url",
        effectStarted: dispatched,
      });
    }
  }),
);

it.effect("maps pre-input click refusals to unsupported with detail and interceptedBy", () =>
  Effect.sync(() => {
    const occluded = new PreviewAutomationExecutionError({
      ...actionErrorContext,
      operation: "click",
      dispatched: false,
      reason: "Target click was refused before dispatch",
      clickRefusal: "occluded_refused",
      interceptedBy: "<div> (dialog) #consent",
    });
    const mappedOccluded = previewActionFailure(occluded, "click");
    expect(mappedOccluded).toMatchObject({
      code: "unsupported",
      detail: "occluded_refused",
      effectStarted: false,
      message: "Target click was refused before dispatch (covered by <div> (dialog) #consent)",
      safety: { possibleCommit: false, retryClass: "fix_input" },
    });

    const special = new PreviewAutomationExecutionError({
      ...actionErrorContext,
      operation: "click",
      dispatched: false,
      reason: "File inputs must use upload()",
      clickRefusal: "special_element_refused",
    });
    expect(previewActionFailure(special, "click")).toMatchObject({
      code: "unsupported",
      detail: "special_element_refused",
      effectStarted: false,
      message: "File inputs must use upload()",
      safety: { possibleCommit: false, retryClass: "fix_input" },
    });
  }),
);
