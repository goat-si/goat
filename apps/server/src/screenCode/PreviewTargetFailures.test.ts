import { expect, it } from "@effect/vitest";
import { PreviewAutomationControlInterruptedError } from "@goat/contracts";
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
