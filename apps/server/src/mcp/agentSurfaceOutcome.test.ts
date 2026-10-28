import { expect, it } from "@effect/vitest";

import { routeOutcome } from "./agentSurfaceOutcome.testkit.ts";

it("never counts goat_eval's own refusals as the target answering", () => {
  const refused = (code: string) => JSON.stringify({ code, message: "goat_eval refused." });
  for (const code of [
    "eval_explicit_key",
    "grant_unresolved",
    "grant_lost",
    "storage_failed",
    "in_progress",
    "idempotency_mismatch",
  ])
    expect(
      routeOutcome({
        route: "goat_eval",
        path: "thread.send",
        effect: "destructive",
        classified: "unexpected",
        text: refused(code),
        directOutcome: "reached",
      }),
      code,
    ).toBe("unexpected");
  // An unknown outcome counts only when it names the target it called.
  const unknown = (path: string) =>
    JSON.stringify({ code: "unknown_outcome", message: `${path} may have run, so ...` });
  const halted = (text: string) =>
    routeOutcome({
      route: "goat_eval",
      path: "thread.send",
      effect: "destructive",
      classified: "unexpected",
      text,
      directOutcome: "reached",
    });
  expect(halted(unknown("thread.send"))).toBe("reached");
  expect(halted(unknown("thread.read"))).toBe("unexpected");
});
