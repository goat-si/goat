import type { OpenCodexInventorySnapshot, OpenCodexSyncMember } from "@goat/contracts";

import type { OpenCodexUpdateMember } from "./opencodexUpdatePlan.ts";

/** Link ids reach a device script inside a grep pattern; anything else is never synced. */
export const SAFE_LINK_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface PlannedSync {
  readonly member: OpenCodexSyncMember;
  /** The Home's link record id a Child must still report when its sync runs. */
  readonly linkId?: string;
}

const skipped = (alias: string | null, reason: string): PlannedSync => ({
  member: { alias, state: "skipped", restartCodex: false, reason },
});

/** The Remote Link Children this machine coordinates, in the Home's own order. */
export const childAliases = (home: OpenCodexInventorySnapshot | undefined) =>
  home?.link.role === "home" ? home.link.links.map(({ alias }) => alias) : [];

/**
 * This machine: a Home, a standalone install, or a Child of another Home. Busy uses the managed
 * update's rule; unknown activity is busy. A busy Home still writes the catalog and leaves the
 * Codex restart for later, but a Child's own sync can restart its runtime after applying its
 * Home's settings (OpenCodex OCX-6), so a busy Child waits entirely.
 */
export function planCoordinator(member: OpenCodexUpdateMember): PlannedSync {
  const snapshot = member.snapshot;
  if (snapshot === undefined) return skipped(null, "unreachable");
  if (!snapshot.installed) return skipped(null, "not-installed");
  const idle = member.runningTurns === 0;
  if (!idle && snapshot.link.role === "child") return skipped(null, "busy");
  return {
    member: {
      alias: null,
      state: "ready",
      restartCodex: idle,
      ...(idle ? {} : { reason: "busy" }),
    },
  };
}

/**
 * One Child of this Home. OpenCodex syncs a connected Child from its Home and never from its own
 * providers, so a Child runs only while the Home holds a link record for it and the Child reports
 * that same link. A record whose tunnel is down is planned with reason `reconnect`: the Home
 * reconnects it before the sync and the Child is checked again. `member` is undefined when it
 * was not read: a Child the caller may not reach, or one the Home has no record for, is never asked.
 */
export function planChild(
  home: OpenCodexInventorySnapshot | undefined,
  alias: string,
  member: OpenCodexUpdateMember | undefined,
  permitted: boolean,
): PlannedSync {
  if (!permitted) return skipped(alias, "not-permitted");
  const record = home?.link.available
    ? home.link.links.find((link) => link.alias === alias)
    : undefined;
  if (record === undefined || !SAFE_LINK_ID.test(record.id)) return skipped(alias, "not-connected");
  const snapshot = member?.snapshot;
  if (snapshot !== undefined && !snapshot.installed) return skipped(alias, "not-installed");
  if (snapshot?.runtime.healthy !== true) return skipped(alias, "unreachable");
  if (snapshot.link.role !== "child" || snapshot.parityEvidence?.childLinkId !== record.id)
    return skipped(alias, "not-connected");
  if (member?.runningTurns !== 0) return skipped(alias, "busy");
  return {
    member: {
      alias,
      state: "ready",
      restartCodex: true,
      ...(record.state === "connected" ? {} : { reason: "reconnect" }),
    },
    linkId: record.id,
  };
}

/** Whether `planChild` needs the Child's own reading at all. */
export const childNeedsReading = (home: OpenCodexInventorySnapshot | undefined, alias: string) =>
  home?.link.available === true && home.link.links.some((link) => link.alias === alias);
