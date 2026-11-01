import { GOAT_HOME_DIR_NAME } from "./goatHome.ts";

/** Packaged stable keeps the location every earlier build used, so rollback finds it. */
export const STABLE_DESKTOP_HOME_DIR_NAME = "desktop";
/**
 * Nightly and preview (dated or PR) builds run beside stable with their own bundled server, so they need
 * their own database, secrets and settings. DesktopChannelStateMigration seeds this from stable once.
 */
export const NIGHTLY_DESKTOP_HOME_DIR_NAME = "desktop-nightly";

/** `resolveDesktopStateDir` appends this for a packaged app and for an explicit home. */
export const DESKTOP_USERDATA_DIR_NAME = "userdata";
/** `resolveDesktopStateDir` appends this for a development build with no explicit home. */
export const DESKTOP_DEV_STATE_DIR_NAME = "dev";

/**
 * State directories of the packaged app's server, which SSH clients attach to: nightly or preview,
 * then stable (also the pre-split layout). The first live server wins. A development build's state
 * (`~/.goat/dev`, `~/.t3/dev`) and an explicit home are never attached.
 */
export const desktopAppServerStateDirs = [
  `${GOAT_HOME_DIR_NAME}/${NIGHTLY_DESKTOP_HOME_DIR_NAME}/${DESKTOP_USERDATA_DIR_NAME}`,
  `${GOAT_HOME_DIR_NAME}/${STABLE_DESKTOP_HOME_DIR_NAME}/${DESKTOP_USERDATA_DIR_NAME}`,
] as const;

/** Quoted `$HOME/...` words for a POSIX `for` loop. The directories contain no shell metacharacters. */
export const desktopAppServerStateDirWords = desktopAppServerStateDirs
  .map((dir) => `"$HOME/${dir}"`)
  .join(" ");
