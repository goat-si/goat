import {
  LEGACY_BOOT_SERVICE_LAUNCHD_LABEL,
  LEGACY_BOOT_SERVICE_UNIT_FILE,
} from "@goat/contracts/legacyT3Names";

/** The names a service manager knows one install by. */
export interface BootServiceNames {
  readonly unitFile: string;
  readonly launchdLabel: string;
}

export const BOOT_SERVICE_NAMES: BootServiceNames = {
  unitFile: "goat.service",
  // Distinct from the desktop app's bundle id (si.goat.desktop), so launchd
  // and TCC records never collide.
  launchdLabel: "si.goat.service",
};

/**
 * Installed by builds before the GOAT rename, and by upstream T3 Code. Install
 * and restart move a legacy unit that serves this GOAT home to the current
 * names; a legacy unit serving another home belongs to someone else.
 */
export const LEGACY_BOOT_SERVICE_NAMES: BootServiceNames = {
  unitFile: LEGACY_BOOT_SERVICE_UNIT_FILE,
  launchdLabel: LEGACY_BOOT_SERVICE_LAUNCHD_LABEL,
};
