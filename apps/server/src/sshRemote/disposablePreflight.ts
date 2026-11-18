import type { SshPreflightReport, SshPreflightStep } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { DisposableRouteGuard } from "../hub/disposable/DisposableRouteGuard.ts";

/**
 * Design section 6: an SSH preflight fails for a disposable machine, by its alias (read offline from
 * Pen's own data) and then the ED25519 key it offers, so the Settings add and the agent add both stop
 * before host-key trust, runtime provisioning and any save. The step keeps no fingerprint.
 */
export const makeRefuseDisposable = Effect.gen(function* () {
  const guard = yield* DisposableRouteGuard;
  return Effect.fn("SshHostSetup.refuseDisposable")(function* (report: SshPreflightReport) {
    const { alias, hostname, user, port } = report.destination;
    const target = alias ?? hostname;
    const named = alias === undefined ? undefined : yield* guard.refusal({ alias }, alias);
    const refusal =
      named ??
      (yield* guard.refusal(
        {
          probe:
            alias === undefined
              ? { alias: hostname, username: user, port }
              : { alias, username: null, port: null },
        },
        target,
      ));
    if (refusal === undefined) return report;
    const refused: SshPreflightStep = {
      id: "host_key",
      state: "failed",
      summary: "This is a disposable machine; GOAT reaches it only through its own Pen route.",
      detail: refusal,
    };
    const steps = report.steps.some((step) => step.id === "host_key")
      ? report.steps.map((step) => (step.id === "host_key" ? refused : step))
      : [...report.steps, refused];
    return { ...report, steps, ready: false };
  });
});
