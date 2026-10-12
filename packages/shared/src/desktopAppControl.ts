import { sha256 } from "@noble/hashes/sha2";
import {
  LEGACY_DESKTOP_APP_PIPE_PREFIX,
  LEGACY_DESKTOP_APP_SOCKET_DIRECTORY_PREFIX,
} from "@goat/contracts/legacyT3Names";

export interface DesktopAppControlAddress {
  readonly address: string;
  readonly directory: string | null;
}

function shortHash(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Returns the local-only socket address shared by the desktop shell and CLI.
 * The state directory is hashed so custom GOAT homes cannot exceed Unix socket
 * path limits.
 */
export function resolveDesktopAppControlAddresses(input: {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly tempDir: string;
  readonly userId: number | undefined;
  readonly joinPath: (...segments: readonly string[]) => string;
}): readonly [DesktopAppControlAddress, DesktopAppControlAddress] {
  const stateHash = shortHash(input.stateDir);
  if (input.platform === "win32") {
    const addressFor = (prefix: string) => ({
      address: `\\\\.\\pipe\\${prefix}${stateHash}`,
      directory: null,
    });
    return [addressFor("goat-app-"), addressFor(LEGACY_DESKTOP_APP_PIPE_PREFIX)];
  }

  const userKey = input.userId === undefined ? stateHash.slice(0, 12) : input.userId;
  const addressFor = (prefix: string) => {
    const directory = input.joinPath(input.tempDir, `${prefix}${userKey}`);
    return { address: input.joinPath(directory, `${stateHash}.sock`), directory };
  };
  return [addressFor("goat-"), addressFor(LEGACY_DESKTOP_APP_SOCKET_DIRECTORY_PREFIX)];
}

/** The primary address for a new desktop; use both addresses for compatibility. */
export const resolveDesktopAppControlAddress = (
  input: Parameters<typeof resolveDesktopAppControlAddresses>[0],
): DesktopAppControlAddress => resolveDesktopAppControlAddresses(input)[0];
