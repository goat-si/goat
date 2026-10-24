/**
 * What a computer use grant handoff admits: whether it is live, the apps a thread's grants admit
 * together, and where two admissions overlap. Pure helpers for ComputerUseLeases.ts.
 *
 * @module computerUseGrants
 */
import { COMPUTER_USE_GRANT_HANDOFF_PATH, Handoff } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ComputerUseLease } from "./ComputerUseLeases.ts";
import { approvedApps } from "./ComputerUseScope.ts";

export const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);

/** A completed grant before its expiry. A grant without an expiry is never live. */
export const leaseOf = (handoff: Handoff, now: DateTime.Utc): Option.Option<ComputerUseLease> =>
  handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
  handoff.state === "completed" &&
  handoff.expiresAt !== null &&
  DateTime.toEpochMillis(handoff.expiresAt) > DateTime.toEpochMillis(now)
    ? Option.some({
        threadId: handoff.requestedBy.threadId,
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
        ...(handoff.apps === undefined ? {} : { apps: handoff.apps }),
      })
    : Option.none();

/** The apps a thread's live grants admit together; absent when one of them admits every app. */
export const appsOf = (
  leases: ReadonlyArray<ComputerUseLease>,
): ReadonlyArray<string> | undefined => {
  const apps = new Set<string>();
  for (const lease of leases) {
    if (lease.apps === undefined) return undefined;
    for (const app of lease.apps) apps.add(app);
  }
  return [...apps].sort();
};

/**
 * The apps of `held` that `wanted` also reaches, matched as the proxy matches them (case aside);
 * undefined when they share none. Without a list an admission reaches every app, so it overlaps
 * every other: the driver acts under it on the whole desktop and in scripts.
 */
export const overlap = (
  held: ReadonlyArray<string> | undefined,
  wanted: ReadonlyArray<string> | undefined,
): { readonly apps?: ReadonlyArray<string> } | undefined => {
  if (held === undefined) return {};
  const names = approvedApps(wanted);
  if (names === undefined) return { apps: held };
  const apps = held.filter((app) => names.has(app.toLowerCase()));
  return apps.length === 0 ? undefined : { apps };
};
