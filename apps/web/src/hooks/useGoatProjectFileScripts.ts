import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type GoatProjectFile,
  type GoatProjectFileScript,
} from "@goat/contracts";
import { parseGoatProjectFile } from "@goat/shared/goatProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<GoatProjectFileScript> = [];

export interface GoatProjectFileState {
  /**
   * - `valid`: t3.json exists and decoded.
   * - `invalid`: t3.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable t3.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: GoatProjectFile | null;
  scripts: ReadonlyArray<GoatProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `t3.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useGoatProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): GoatProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseGoatProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}
