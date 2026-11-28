import { GOAT_PROJECT_FILE_NAME, type EnvironmentId, type GoatProjectFile } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import { goatProjectFileReadPath } from "@goat/client-runtime/goat-project-file";
import * as Cause from "effect/Cause";
import { parseGoatProjectFile } from "@goat/shared/goatProjectFile";
import { executeAtomQuery } from "@goat/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * What a project's checked-in `goat.json` (or legacy `t3.json`) says. `known: false` means the
 * read could not tell, for example while a remote environment is still connecting; a missing
 * file is known and has `file: null`.
 */
export type GoatProjectFileLookup =
  | { readonly known: true; readonly file: GoatProjectFile | null }
  | { readonly known: false };

interface InFlightProjectFileLoad {
  readonly promise: Promise<GoatProjectFileLookup>;
  readonly controller: AbortController;
  activeWaiters: number;
}

const UNKNOWN: GoatProjectFileLookup = { known: false };
// The last known contents per project, kept for the session so opening a new thread never waits
// for a file read. Every load refreshes it.
const lastKnownFiles = new Map<string, GoatProjectFile | null>();
const loadsInFlight = new Map<string, InFlightProjectFileLoad>();
// A prefetch only warms the cache; it gives up instead of holding a mounted query while an
// environment stays unreachable.
const PREFETCH_TIMEOUT_MS = 15_000;

function projectFileKey(environmentId: EnvironmentId, workspaceRoot: string): string {
  return JSON.stringify([environmentId, workspaceRoot]);
}

export function clearGoatProjectFileDefaultsForTests(): void {
  for (const entry of loadsInFlight.values()) entry.controller.abort();
  lastKnownFiles.clear();
  loadsInFlight.clear();
}

/** The last known project file, read synchronously so a new-thread request can open at once. */
export function peekGoatProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): GoatProjectFileLookup {
  const key = projectFileKey(environmentId, workspaceRoot);
  return lastKnownFiles.has(key) ? { known: true, file: lastKnownFiles.get(key) ?? null } : UNKNOWN;
}

/**
 * Read and decode the project's checked-in file, and remember the answer for
 * `peekGoatProjectFile`. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Truncated or invalid files resolve to `file: null`; a read that
 * failed for another reason, or was aborted, resolves to unknown and leaves the cache alone.
 */
export function loadGoatProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GoatProjectFileLookup> {
  if (options.signal?.aborted) return Promise.resolve(UNKNOWN);
  const key = projectFileKey(environmentId, workspaceRoot);
  let entry = loadsInFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    const read = async (relativePath: string) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        getProjectFileQueryAtom(environmentId, workspaceRoot, relativePath),
        {
          reportDefect: false,
          reportFailure: false,
          signal: controller.signal,
        },
      );
      const data = resolveProjectFileQueryData(
        environmentId,
        workspaceRoot,
        relativePath,
        result._tag === "Success" ? result.value : null,
      );
      return { data, error: result._tag === "Failure" ? Cause.squash(result.cause) : null };
    };
    const promise = (async (): Promise<GoatProjectFileLookup> => {
      const primary = await read(GOAT_PROJECT_FILE_NAME);
      if (controller.signal.aborted) return UNKNOWN;
      const relativePath = goatProjectFileReadPath(primary.data, primary.error);
      const settled = relativePath === GOAT_PROJECT_FILE_NAME ? primary : await read(relativePath);
      if (controller.signal.aborted) return UNKNOWN;
      let lookup: GoatProjectFileLookup = UNKNOWN;
      if (settled.data !== null) {
        lookup = {
          known: true,
          file:
            settled.data.exists === false || settled.data.truncated
              ? null
              : parseGoatProjectFile(settled.data.contents),
        };
      } else if (
        relativePath === LEGACY_PROJECT_FILE_NAME &&
        goatProjectFileReadPath(null, settled.error) === LEGACY_PROJECT_FILE_NAME
      ) {
        // Neither file exists.
        lookup = { known: true, file: null };
      }
      if (lookup.known) lastKnownFiles.set(key, lookup.file);
      return lookup;
    })().finally(() => {
      if (loadsInFlight.get(key) === activeEntry) loadsInFlight.delete(key);
    });
    const activeEntry: InFlightProjectFileLoad = { promise, controller, activeWaiters: 0 };
    entry = activeEntry;
    loadsInFlight.set(key, entry);
  }
  const activeEntry = entry;
  activeEntry.activeWaiters += 1;
  const signal = options.signal;
  if (!signal) {
    return activeEntry.promise.finally(() => {
      activeEntry.activeWaiters -= 1;
    });
  }
  return new Promise<GoatProjectFileLookup>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      activeEntry.activeWaiters -= 1;
      if (activeEntry.activeWaiters === 0) {
        activeEntry.controller.abort();
        if (loadsInFlight.get(key) === activeEntry) loadsInFlight.delete(key);
      }
      resolve(UNKNOWN);
    };
    const onResolve = (value: GoatProjectFileLookup) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      activeEntry.activeWaiters -= 1;
      resolve(value);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void activeEntry.promise.then(onResolve, () => onResolve(UNKNOWN));
  });
}

/** Warm `peekGoatProjectFile` for projects the user is about to choose between. */
export function prefetchGoatProjectFiles(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
): void {
  for (const project of projects) {
    if (project.workspaceRoot === "") continue;
    if (peekGoatProjectFile(project.environmentId, project.workspaceRoot).known) continue;
    void loadGoatProjectFile(project.environmentId, project.workspaceRoot, {
      signal: AbortSignal.timeout(PREFETCH_TIMEOUT_MS),
    });
  }
}
