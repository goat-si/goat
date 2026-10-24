import type { EnvironmentId, ProjectEntry } from "@goat/contracts";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";

import { toastManager } from "~/components/ui/toast";
import type { useFileContextMenu } from "~/fileContextMenu";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { copyFileContents, copyFileNames } from "./fileContentsCopy";
import { getProjectFileQueryAtom } from "./projectFilesQueryState";

/** Reveal and copy actions for tree rows, shared by the row menu and the shortcuts. */
export function useFileTreeActions(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly panelPath: (row: string) => string;
  readonly entryKind: (row: string) => ProjectEntry["kind"] | undefined;
  readonly fileContextMenu: ReturnType<typeof useFileContextMenu>;
}) {
  const readFile = useAtomQueryRunner(
    (path: string) => getProjectFileQueryAtom(input.environmentId, input.workspaceRoot, path),
    { reportFailure: false, refresh: true },
  );
  const copyNames = (rows: readonly string[]) => copyFileNames(rows.map(input.panelPath));
  const copyContents = async (rows: readonly string[]) => {
    const [row] = rows;
    if (rows.length !== 1 || row === undefined || input.entryKind(row) !== "file") {
      toastManager.add({ type: "error", title: "Select one file to copy its contents" });
      return;
    }
    const path = input.panelPath(row);
    const result = await readFile(path);
    await copyFileContents(
      path,
      result._tag === "Success"
        ? { _tag: "Success", value: result.value }
        : { _tag: "Failure", error: squashAtomCommandFailure(result) },
    );
  };
  // The server reveals one path; a multi-selection reveals its first row like the row menu.
  const reveal = async (rows: readonly string[]) => {
    const [row] = rows;
    if (row === undefined) return;
    if (input.fileContextMenu.capabilities.revealLabel === undefined) {
      toastManager.add({ type: "error", title: "Reveal is not available on this environment" });
      return;
    }
    await input.fileContextMenu.activate("reveal-in-folder", {
      environmentId: input.environmentId,
      filePath: row,
      workspaceRoot: input.cwd,
    });
  };
  return { copyNames, copyContents, reveal };
}
