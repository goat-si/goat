import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
  type ProjectWriteFileResult,
  GOAT_PROJECT_FILE_NAME,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@goat/client-runtime/state/runtime";
import { revisionedQuery } from "~/state/revisionedQuery";

import { FileSaveSession } from "./fileSaveCoordinator";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_ENTRIES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectListEntriesResult, never>(false),
);
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
export function optimisticFileAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

const fileSaveSessions = new WeakMap<ReturnType<typeof optimisticFileAtom>, FileSaveSession>();

export function getProjectFileSaveSession(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): FileSaveSession {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  let session = fileSaveSessions.get(atom);
  if (!session) {
    session = new FileSaveSession();
    fileSaveSessions.set(atom, session);
  }
  return session;
}

// Dirty contents must survive a closed preview, including failed or unauthorized saves.
const unsavedFileMounts = new Map<ReturnType<typeof optimisticFileAtom>, () => void>();

function releaseUnsavedFile(atom: ReturnType<typeof optimisticFileAtom>): void {
  const unmount = unsavedFileMounts.get(atom);
  unsavedFileMounts.delete(atom);
  unmount?.();
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

interface ProjectFileQueryState extends ProjectQueryState<ProjectReadFileResult> {
  readonly readError: ProjectReadFileError | null;
  readonly isNotFile: boolean;
  readonly isFile: boolean;
}

function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: {
      cwd,
      relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH,
      ...(relativePath === GOAT_PROJECT_FILE_NAME ? { allowMissing: true } : {}),
    },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  if (!unsavedFileMounts.has(atom)) {
    unsavedFileMounts.set(atom, appAtomRegistry.mount(atom));
  }
  const baseline =
    appAtomRegistry.get(atom)?.data ?? getProjectFileData(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, {
    confirmedAgainst: undefined,
    data: {
      ...baseline,
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

/** Retain the version that produced a dirty buffer, even when the query refreshes. */
export function getProjectFileData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  const optimistic = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
  if (optimistic) return optimistic;
  return Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath)),
    ),
  );
}

export async function reloadProjectFileData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  const query = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  appAtomRegistry.refresh(query);
  const result = await executeAtomQuery(appAtomRegistry, query, {
    reportDefect: false,
    reportFailure: false,
  });
  if (result._tag === "Success") {
    clearProjectFileQueryData(environmentId, cwd, relativePath);
    getProjectFileSaveSession(environmentId, cwd, relativePath).discard();
  }
  return result;
}

export function getProjectFileContents(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): string | undefined {
  const optimistic = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
  if (optimistic) return optimistic.contents;
  const result = appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  const data = Option.getOrUndefined(AsyncResult.value(result));
  return data?.exists === false ? undefined : data?.contents;
}

export function getUnsavedProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic?.confirmedAgainst === undefined ? (optimistic?.data ?? null) : null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
  written?: ProjectWriteFileResult,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  let optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile && written?.version !== undefined) {
    optimisticFile = {
      ...optimisticFile,
      data: { ...optimisticFile.data, version: written.version },
    };
    appAtomRegistry.set(atom, optimisticFile);
  }
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  releaseUnsavedFile(atom);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, null);
  releaseUnsavedFile(atom);
}

function failureCause<A>(result: AsyncResult.AsyncResult<A, unknown>): unknown {
  return result._tag === "Failure" ? Cause.squash(result.cause) : null;
}

function errorMessage(cause: unknown): string | null {
  if (cause === null) return null;
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

const isProjectReadFileError = Schema.is(ProjectReadFileError);

/** `revision` is the workspace mutation id; a new one refetches the listing. */
export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
  revision?: string | null,
): ProjectQueryState<ProjectListEntriesResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const atom = canReadFiles
    ? getProjectEntriesQueryAtom(environmentId, cwd, directoryPath)
    : EMPTY_PROJECT_ENTRIES_QUERY_ATOM;
  const result = useAtomValue(revisionedQuery(atom, canReadFiles ? revision : undefined));
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: fileAccess.isPending
      ? null
      : canReadFiles
        ? errorMessage(failureCause(result))
        : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: fileAccess.isPending || result.waiting,
    refresh,
  };
}

/** Empty queries return frecency-ranked files without transferring the full workspace listing. */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean; readonly includeDirectories?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      ...(options?.includeDirectories && query.trim() ? {} : { kind: "file" as const }),
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectFileQueryState {
  // Read media-like paths too; a failed read is how folders with those names are detected.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const isQueryEnabled = enabled;
  const atom =
    enabled && canReadFiles
      ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  const readData = Option.getOrNull(AsyncResult.value(result));
  const isMissing = readData?.exists === false;
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);
  const readError = isProjectReadFileError(cause) ? cause : null;
  const data = canReadFiles ? (optimisticFile?.data ?? (isMissing ? null : readData)) : null;
  const isNotFile = readError?.failure === "path_not_file";

  return {
    data,
    error:
      !isQueryEnabled || fileAccess.isPending
        ? null
        : canReadFiles
          ? isMissing && !optimisticFile
            ? `'${relativePath}' does not exist.`
            : errorMessage(cause)
          : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: isQueryEnabled && (fileAccess.isPending || result.waiting),
    readError,
    isNotFile,
    // A folder error overrides cached contents retained across failed refreshes.
    isFile: !isNotFile && (data !== null || readError?.failure === "binary_file"),
    refresh,
  };
}
