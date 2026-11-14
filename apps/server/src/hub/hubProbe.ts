import * as Effect from "effect/Effect";

import { DisposableRouteGuard } from "./disposable/DisposableRouteGuard.ts";
import type { HubOcx } from "./HubOcx.ts";
import { decodeJson, Probe } from "./hubOcxJson.ts";

const HOME_TIMEOUT_MS = 60_000;

/** The phase a probe answers when the device is a disposable machine (phaseMessage shows it as is). */
const DISPOSABLE_PHASE = "disposable_machine";

/**
 * Design section 6: disposableRoute says why a kept path may not route to an alias (its Pen alias,
 * offline, then the GOAT it runs, then with `probeKey` its ED25519 key); the probe that join, repair
 * and move read refuses the alias before asking OpenCodex, and an offered ED25519 sshd key after.
 */
export const makeHubProbe = Effect.fn("HubMembership.makeProbe")(function* (
  ocx: HubOcx["Service"],
) {
  const guard = yield* DisposableRouteGuard;
  const disposableRoute = Effect.fn("HubMembership.disposableRoute")(function* (
    alias: string,
    /** The environment the alias reaches when already read; identified here when absent. */
    environmentId?: string | null,
    /** Also reads and compares the ED25519 key the alias offers (a path with no OpenCodex probe). */
    probeKey = false,
  ) {
    return yield* guard.refusal(
      {
        alias,
        identify: environmentId === undefined ? ocx.identify(alias) : Effect.succeed(environmentId),
        ...(probeKey ? { probe: { alias, username: null, port: null } } : {}),
      },
      alias,
    );
  });
  const probe = Effect.fn("HubMembership.probe")(function* (alias: string) {
    const named = yield* guard.refusal({ alias }, alias);
    if (named !== undefined) return { ok: false as const, phase: DISPOSABLE_PHASE, message: named };
    const output = yield* ocx.home(["link", "probe", alias, "--json"], HOME_TIMEOUT_MS);
    const offered = output.code === 0 ? decodeJson(Probe, output.stdout) : undefined;
    if (offered?.alias !== alias)
      return { ok: false as const, phase: output.phase, message: output.message };
    // A pin is an ED25519 fingerprint; a key of another type says nothing either way.
    const claim =
      offered.keyType === "ssh-ed25519"
        ? yield* guard.refusal({ hostKeyFingerprint: offered.fingerprint }, alias)
        : undefined;
    return claim === undefined
      ? { ok: true as const, ...offered }
      : { ok: false as const, phase: DISPOSABLE_PHASE, message: claim };
  });
  return { probe, disposableRoute };
});
