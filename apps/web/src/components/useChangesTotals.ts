import type { EnvironmentId, ScopedThreadRef, VcsStatusResult } from "@goat/contracts";
import {
  selectThreadBranchBaseRef,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "~/diffPanelStore";
import { useClientSettings } from "~/hooks/useSettings";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import { resolveChangesTotals } from "./GitActionsControl.logic";

export function useChangesTotals(input: {
  activeThreadRef: ScopedThreadRef | null;
  activeEnvironmentId: EnvironmentId | null;
  gitCwd: string | null;
  gitStatus: VcsStatusResult | null | undefined;
  isPanel: boolean;
  isRepo: boolean;
  workspaceMutationId: string | null;
}) {
  const baseRef = useDiffPanelStore((state) =>
    selectThreadBranchBaseRef(state, input.activeThreadRef),
  );
  const setting = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const ignoreWhitespace = useDiffPanelSessionStore((state) => state.ignoreWhitespace) ?? setting;
  const { canReadFiles } = useFilesystemReadAccess(input.activeEnvironmentId);
  const status = input.gitStatus;
  const revision = status
    ? JSON.stringify([
        input.workspaceMutationId,
        status.refName,
        status.workingTree.insertions,
        status.workingTree.deletions,
        status.branchChanges?.baseRef,
        status.branchChanges?.insertions,
        status.branchChanges?.deletions,
      ])
    : null;
  const preview = useEnvironmentQuery(
    input.isPanel &&
      input.isRepo &&
      canReadFiles &&
      revision !== null &&
      input.activeEnvironmentId !== null &&
      input.gitCwd !== null
      ? revisionedQuery(
          reviewEnvironment.diffPreview({
            environmentId: input.activeEnvironmentId,
            input: {
              cwd: input.gitCwd,
              ...(baseRef ? { baseRef } : {}),
              ignoreWhitespace,
              metadataOnly: true,
              scope: "branch-range",
            },
          }),
          revision,
        )
      : null,
  );
  return (
    resolveChangesTotals(
      status,
      preview.data?.sources.find((source) => source.kind === "branch-range"),
    ) ?? { insertions: 0, deletions: 0, baseRef: null }
  );
}
