import { expect, it } from "@effect/vitest";
import { PreviewAutomationControlInterruptedError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { actionErrorContext, browserFixture } from "./PreviewTargetHost.testkit.ts";

it.effect.each([
  ["read_page", "read", {}],
  ["wait_for", "waitFor", { text: "Ready" }],
] as const)(
  "screen %s preserves the run identity and blocked refusal",
  ([method, operation, input]) =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      fixture.state.failure = new PreviewAutomationControlInterruptedError({
        ...actionErrorContext,
        operation,
        reason: "blocked_url",
        dispatched: false,
      });
      const result = yield* fixture.dispatch(method, input);
      expect(result?.error).toMatchObject({ code: "blocked_url", effectStarted: false });
      expect(fixture.requests.find((request) => request.operation === operation)?.runId).toBe(
        "run",
      );
    }),
);
