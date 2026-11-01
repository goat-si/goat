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

it.effect("a blocked tab claim returns blocked_url without acquiring a claim", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    fixture.state.failure = new PreviewAutomationControlInterruptedError({
      ...actionErrorContext,
      operation: "claim",
      reason: "blocked_url",
      dispatched: false,
    });
    const result = yield* fixture.dispatch("claim_tab");
    expect(result?.error).toMatchObject({ code: "blocked_url", effectStarted: false });
    expect(fixture.requests.find((request) => request.operation === "claim")?.runId).toBe("run");
  }),
);

it.effect("screen fetch passes the active run identity and preserves a blocked refusal", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    fixture.state.failure = new PreviewAutomationControlInterruptedError({
      ...actionErrorContext,
      operation: "fetch",
      reason: "blocked_url",
      dispatched: false,
    });
    const result = yield* fixture.dispatch("fetch_tab", { url: "https://example.test/resource" });
    expect(result?.error).toMatchObject({ code: "blocked_url", effectStarted: false });
    expect(fixture.requests.find((request) => request.operation === "fetch")?.runId).toBe("run");
  }),
);
