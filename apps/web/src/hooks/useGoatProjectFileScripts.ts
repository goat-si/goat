import {
  GOAT_PROJECT_FILE_NAME,
  type EnvironmentId,
  type GoatProjectFile,
  type GoatProjectFileScript,
} from "@goat/contracts";
import { goatProjectFileReadPath } from "@goat/client-runtime/goat-project-file";
import { parseGoatProjectFile } from "@goat/shared/goatProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<GoatProjectFileScript> = [];

export interface GoatProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: GoatProjectFile | null;
  scripts: ReadonlyArray<GoatProjectFileScript>;
  /** Path read from the checkout, or goat.json when no file was read. */
  relativePath: string;
}

export function useGoatProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): GoatProjectFileState {
  const primary = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    GOAT_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const relativePath = goatProjectFileReadPath(primary.data, primary.readError, primary.isPending);
  const legacy = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    relativePath,
    cwd !== null && relativePath !== GOAT_PROJECT_FILE_NAME,
  );
  const query = relativePath === GOAT_PROJECT_FILE_NAME ? primary : legacy;
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status:
        query.data?.truncated || query.isNotFile ? "invalid" : isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
      relativePath: query.data === null && !query.isNotFile ? GOAT_PROJECT_FILE_NAME : relativePath,
    } as const;
  }
  const file = parseGoatProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS, relativePath } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS, relativePath } as const;
}
