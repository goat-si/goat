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

const UNKNOWN: GoatProjectFileLookup = { known: false };
// The last known contents per project, kept for the session so opening a new thread never waits
// for a file read. Every load refreshes it.
const lastKnownFiles = new Map<string, GoatProjectFile | null>();
const loadsInFlight = new Map<string, Promise<GoatProjectFileLookup>>();
// A prefetch only warms the cache; it gives up instead of holding a mounted query while an
// environment stays unreachable.
const PREFETCH_TIMEOUT_MS = 15_000;

function projectFileKey(environmentId: EnvironmentId, workspaceRoot: string): string {
  return JSON.stringify([environmentId, workspaceRoot]);
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
  const key = projectFileKey(environmentId, workspaceRoot);
  const inFlight = loadsInFlight.get(key);
  if (inFlight) return inFlight;
  const read = async (relativePath: string) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, relativePath),
      {
        reportDefect: false,
        reportFailure: false,
        ...(options.signal ? { signal: options.signal } : {}),
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
  const load = (async (): Promise<GoatProjectFileLookup> => {
    const primary = await read(GOAT_PROJECT_FILE_NAME);
    const relativePath = goatProjectFileReadPath(primary.data, primary.error);
    const settled = relativePath === GOAT_PROJECT_FILE_NAME ? primary : await read(relativePath);
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
  })().finally(() => loadsInFlight.delete(key));
  loadsInFlight.set(key, load);
  return load;
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
