import type { ConnectionTarget } from "@goat/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
} from "@goat/contracts";

import { desktopLocalBackendId } from "@goat/client-runtime/connection";
export {
  desktopLocalConnectionId,
  isDesktopLocalConnectionTarget,
  desktopLocalBackendId,
} from "@goat/client-runtime/connection";

export function isWslConnectionTarget(target: ConnectionTarget): boolean {
  return desktopLocalBackendId(target)?.startsWith("wsl:") === true;
}

export const DESKTOP_LOCAL_BOOTSTRAPS_CACHE_TTL_MS = 15_000;

export type DesktopLocalBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export type DesktopSecondaryBootstrapsRead = DesktopLocalBootstrapsRead;

interface CachedLocalBootstraps {
  readonly reader: () => readonly DesktopEnvironmentBootstrap[];
  readonly expiresAtMs: number;
  readonly result: Extract<DesktopLocalBootstrapsRead, { readonly _tag: "Success" }>;
}

let cachedLocalBootstraps: CachedLocalBootstraps | null = null;

export function invalidateDesktopLocalBootstrapsCache(): void {
  cachedLocalBootstraps = null;
}

/**
 * Reads local desktop environment bootstraps with a short renderer-memory cache keyed by
 * the bridge reader function so hot-path callers share one sync IPC read per TTL window.
 */
export function readDesktopLocalBootstrapsResult(
  bridge: Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined = typeof window ===
  "undefined"
    ? undefined
    : window.desktopBridge,
  ttlMs: number = DESKTOP_LOCAL_BOOTSTRAPS_CACHE_TTL_MS,
): DesktopLocalBootstrapsRead {
  const reader = bridge?.getLocalEnvironmentBootstraps;
  if (reader === undefined) {
    cachedLocalBootstraps = null;
    return { _tag: "Success", bootstraps: [] };
  }
  const now = Date.now();
  if (
    ttlMs > 0 &&
    cachedLocalBootstraps !== null &&
    cachedLocalBootstraps.reader === reader &&
    now < cachedLocalBootstraps.expiresAtMs
  ) {
    return cachedLocalBootstraps.result;
  }
  try {
    const bootstraps = reader();
    const result: Extract<DesktopLocalBootstrapsRead, { readonly _tag: "Success" }> = {
      _tag: "Success",
      bootstraps,
    };
    if (ttlMs > 0) {
      cachedLocalBootstraps = {
        reader,
        expiresAtMs: now + ttlMs,
        result,
      };
    }
    return result;
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

function readDesktopLocalBootstraps(
  bridge: Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined = typeof window ===
  "undefined"
    ? undefined
    : window.desktopBridge,
): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const result = readDesktopLocalBootstrapsResult(bridge);
  return result._tag === "Success" ? result.bootstraps : [];
}

export function readDesktopPrimaryBootstrap(
  bridge: Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined = typeof window ===
  "undefined"
    ? undefined
    : window.desktopBridge,
): DesktopEnvironmentBootstrap | null {
  return (
    readDesktopLocalBootstraps(bridge).find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID) ??
    null
  );
}

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
}

/** Empty reads clear the snapshot; failed reads retain platform registrations. */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      if (snapshot.length > 0) snapshot = [];
      return { _tag: "Success", bootstraps: snapshot };
    }
    const read = readDesktopLocalBootstrapsResult(bridge);
    if (read._tag === "Failure") {
      return read;
    }
    const next = read.bootstraps.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (
      next.length !== snapshot.length ||
      next.some((entry, index) => {
        const previous = snapshot[index];
        return (
          previous === undefined ||
          entry.id !== previous.id ||
          entry.label !== previous.label ||
          entry.runningDistro !== previous.runningDistro ||
          entry.httpBaseUrl !== previous.httpBaseUrl ||
          entry.wsBaseUrl !== previous.wsBaseUrl ||
          entry.bootstrapToken !== previous.bootstrapToken ||
          entry.accessToken !== previous.accessToken
        );
      })
    ) {
      snapshot = next;
    }
    return { _tag: "Success", bootstraps: snapshot };
  };

  return {
    readResult,
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(
  () => window.desktopBridge,
);

export function readDesktopSecondaryBootstrapsResult(): DesktopSecondaryBootstrapsRead {
  return desktopSecondaryBootstrapsReader.readResult();
}

export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}
