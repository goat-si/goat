/**
 * What a computer use grant handoff admits: the apps a thread's grants admit together,
 * and where two admissions overlap. Pure helpers for ComputerUseLeases.ts.
 *
 * @module computerUseGrants
 */
import type { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { ComputerUseLease } from "./ComputerUseLeases.ts";
import { approvedApps } from "./ComputerUseScope.ts";

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

/** A thread whose admission overlaps one asked for, by grant or by unattended full access. */
export interface ComputerUseHolder {
  readonly threadId: ThreadId;
  readonly expiresAt: DateTime.Utc;
  /** The holder's apps in the way, as its grant names them; absent when it holds the whole screen. */
  readonly apps?: ReadonlyArray<string>;
}

/**
 * The thread other than `except` whose admission reaches an app `apps` names, or any app when
 * `apps` is absent: a live grant first, else unattended work admitted to every app.
 */
export const holderOf = (
  grants: ReadonlyArray<ComputerUseLease>,
  except: ThreadId | undefined,
  apps: ReadonlyArray<string> | undefined,
  admitted: { readonly threadId: ThreadId; readonly expiresAt: DateTime.Utc } | undefined,
): Option.Option<ComputerUseHolder> => {
  for (const lease of grants) {
    if (lease.threadId === except) continue;
    const shared = overlap(lease.apps, apps);
    if (shared !== undefined)
      return Option.some({ threadId: lease.threadId, expiresAt: lease.expiresAt, ...shared });
  }
  return admitted === undefined
    ? Option.none()
    : Option.some({ threadId: admitted.threadId, expiresAt: admitted.expiresAt });
};

const heldApps = (holder: ComputerUseHolder) =>
  holder.apps === undefined ? "the whole screen" : holder.apps.join(", ");

/** Who holds what an admission would overlap, and until when, as one sentence for an agent. */
export const describeHolder = (holder: ComputerUseHolder) =>
  `Thread ${holder.threadId} holds ${heldApps(holder)} on this host until ${DateTime.formatIso(holder.expiresAt)}.`;

/**
 * The same sentence for a person on an approval card: the holder by its title, and the end as a
 * UTC clock time like the request's own text, since the server does not know the reader's zone.
 */
export const describeHolderForPerson = (holder: ComputerUseHolder, title: string | undefined) =>
  `${title === undefined ? "Another thread" : `The thread "${title}"`} holds ${heldApps(holder)} on this host until ${DateTime.formatIso(holder.expiresAt).slice(11, 16)} UTC.`;
