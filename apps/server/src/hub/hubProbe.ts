import * as Effect from "effect/Effect";

import { DisposableMachineStore } from "./disposable/DisposableMachineStore.ts";
import { claimedBy, refusalText } from "./disposable/routeGuard.ts";
import type { HubOcx } from "./HubOcx.ts";
import { decodeJson, Probe } from "./hubOcxJson.ts";

const HOME_TIMEOUT_MS = 60_000;

/** The phase a probe answers when the device is a disposable machine; its message is GOAT's own. */
export const DISPOSABLE_PHASE = "disposable_machine";

/**
 * Home's ocx link probe, which join, the repair re-link and move read before they link. Design
 * section 6: a disposable machine is reached only through its own Pen route, so a probe of its Pen
 * alias, or one that offers its sshd key under any alias, answers as a refusal before any link.
 */
export const makeHubProbe = Effect.fn("HubMembership.makeProbe")(function* (
  ocx: HubOcx["Service"],
) {
  const disposable = yield* DisposableMachineStore;
  return Effect.fn("HubMembership.probe")(function* (alias: string) {
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
});
