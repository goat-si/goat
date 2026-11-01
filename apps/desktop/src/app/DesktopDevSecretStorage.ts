import * as Effect from "effect/Effect";

import type * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { isIsolatedDesktopBaseDir } from "./DesktopStatePaths.ts";

/**
 * Whether this run keeps secrets out of the OS key store (macOS Keychain, Linux Secret Service).
 *
 * Every unsigned dev bundle has its own code identity, so macOS asks for the login keychain
 * password whenever one reads the shared `GOAT Dev Safe Storage` item, and the prompt blocks
 * automated UI checks. With `GOAT_DEV_INSECURE_SECRET_STORAGE` set, an unpackaged dev run in an
 * isolated home stores development-plaintext blobs instead, and safe storage, the startup key
 * migration and sibling-key recovery all skip the key store. Packaged builds and the live
 * `~/.goat`/`~/.t3` homes never qualify.
 */
export const bypassesOsKeyStore = Effect.fnUntraced(function* (
  environment: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    | "isPackaged"
    | "isDevelopment"
    | "insecureDevSecretStorage"
    | "homeDirectory"
    | "baseDir"
    | "platform"
  >,
) {
  if (
    environment.isPackaged ||
    !environment.isDevelopment ||
    environment.insecureDevSecretStorage !== true
  ) {
    return false;
  }
  return yield* isIsolatedDesktopBaseDir({
    homeDirectory: environment.homeDirectory,
    baseDir: environment.baseDir,
    platform: environment.platform,
  });
});
