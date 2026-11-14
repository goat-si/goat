import * as Effect from "effect/Effect";

import { DisposableMachineStore } from "./disposable/DisposableMachineStore.ts";
import { claimedBy, refusalText } from "./disposable/routeGuard.ts";
import type { HubOcx } from "./HubOcx.ts";
import { decodeJson, Probe } from "./hubOcxJson.ts";

const HOME_TIMEOUT_MS = 60_000;

/** The phase a probe answers when the device is a disposable machine (phaseMessage shows it as is). */
const DISPOSABLE_PHASE = "disposable_machine";

/**
 * Design section 6: a disposable machine is reached only through its own Pen route. disposableRoute
 * says why a kept path may not route to an alias (its Pen alias, checked before any network, then
 * the GOAT it runs); the probe join, the repair re-link and move read before they link answers a
 * refusal for a Pen alias before asking OpenCodex, and for an offered sshd key after.
 */
export const makeHubProbe = Effect.fn("HubMembership.makeProbe")(function* (
  ocx: HubOcx["Service"],
) {
  const disposable = yield* DisposableMachineStore;
  const disposableRoute = Effect.fn("HubMembership.disposableRoute")(function* (
    alias: string,
    /** The environment the alias reaches when already read; identified here when absent. */
    environmentId?: string | null,
  ) {
    const records = yield* disposable.recordsOrKept;
    const byAlias = claimedBy(records, { alias });
    if (byAlias !== undefined) return refusalText(byAlias, alias);
    if (records.every((record) => record.final)) return undefined;
    const identity = environmentId === undefined ? yield* ocx.identify(alias) : environmentId;
    const byEnvironment = claimedBy(records, { environmentId: identity ?? null });
    return byEnvironment === undefined ? undefined : refusalText(byEnvironment, alias);
  });
  const probe = Effect.fn("HubMembership.probe")(function* (alias: string) {
    const named = claimedBy(yield* disposable.recordsOrKept, { alias });
    if (named !== undefined)
      return { ok: false as const, phase: DISPOSABLE_PHASE, message: refusalText(named, alias) };
    const output = yield* ocx.home(["link", "probe", alias, "--json"], HOME_TIMEOUT_MS);
    const offered = output.code === 0 ? decodeJson(Probe, output.stdout) : undefined;
    if (offered?.alias !== alias)
      return { ok: false as const, phase: output.phase, message: output.message };
    const claim = claimedBy(yield* disposable.recordsOrKept, {
      alias,
      hostKeyFingerprint: offered.fingerprint,
    });
    return claim === undefined
      ? { ok: true as const, ...offered }
      : { ok: false as const, phase: DISPOSABLE_PHASE, message: refusalText(claim, alias) };
  });
  return { probe, disposableRoute };
});
