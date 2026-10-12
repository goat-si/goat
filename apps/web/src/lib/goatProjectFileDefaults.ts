import { GOAT_PROJECT_FILE_NAME, type EnvironmentId, type GoatProjectFile } from "@goat/contracts";
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
 * Read and decode the project's checked-in `t3.json`.
 *
 * Imperative counterpart to `useGoatProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readGoatProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<GoatProjectFile | null> {
  const read = async (relativePath: string) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, relativePath),
      { reportDefect: false, reportFailure: false },
    );
    const data = resolveProjectFileQueryData(
      environmentId,
      workspaceRoot,
      relativePath,
      result._tag === "Success" ? result.value : null,
    );
    return { data, error: result._tag === "Failure" ? Cause.squash(result.cause) : null };
  };
  const primary = await read(GOAT_PROJECT_FILE_NAME);
  const relativePath = goatProjectFileReadPath(primary.data, primary.error);
  const { data } = relativePath === GOAT_PROJECT_FILE_NAME ? primary : await read(relativePath);
  if (data === null || data.truncated) return null;
  return parseGoatProjectFile(data.contents);
}
