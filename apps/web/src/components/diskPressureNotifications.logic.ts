import type { HostPressureLevel } from "@goat/contracts";

const RANK: Readonly<Record<HostPressureLevel, number>> = { ok: 0, elevated: 1, critical: 2 };

/**
 * Whether a machine's disk level is news. Only a rise above the level last announced notifies;
 * easing records the lower level, so getting worse again notifies again, and staying at a level
 * (including across reloads, since the announced level is stored) never repeats it.
 */
export function diskPressureNotice(
  announced: HostPressureLevel | null,
  level: HostPressureLevel,
): { readonly notify: boolean; readonly announce: HostPressureLevel } {
  return { notify: RANK[level] > RANK[announced ?? "ok"], announce: level };
}

/**
 * The level to store once a reading was handled, or null to keep the stored one. A rise counts as
 * announced only after the person was actually shown it, so a warning that found no visible page
 * and no desktop notification stays pending until the page is seen again.
 */
export const announcedAfter = (
  notice: { readonly notify: boolean; readonly announce: HostPressureLevel },
  delivered: boolean,
): HostPressureLevel | null => (notice.notify && !delivered ? null : notice.announce);

export const diskPressureStorageKey = (environmentId: string) =>
  "goat:disk-pressure-announced:" + environmentId;

export const parseAnnouncedLevel = (value: string | null): HostPressureLevel | null =>
  value === "ok" || value === "elevated" || value === "critical" ? value : null;
