import {
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
  type VcsStatusResult,
} from "@goat/contracts";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { scopedThreadKey } from "@goat/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { useEffect, useRef } from "react";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { relinkPullRequestList } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Relink replaced closed/merged requests to the newer open request on the same branch, moving its panel. */
export function useThreadLinkedPullRequest(input: {
  readonly serverThreadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly persisted: ThreadLinkedPullRequest | null;
  readonly projectId: ProjectId | null;
  readonly projectRepository: string | null;
  readonly threadBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
}) {
  const { serverThreadRef, persisted, projectId, projectRepository, threadBranch, gitStatus } =
    input;
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const persistedStatus = useLinkedThreadPullRequest(input.environmentId, persisted);
  const detected = gitStatus?.pr;
  const branchPullRequest = useQuietThreadShell(serverThreadRef)?.branchPullRequest;
  const matchingBranch =
    detected &&
    branchPullRequest &&
    sourceControlClients.isSameChangeRequest(detected.url, branchPullRequest.url)
      ? branchPullRequest
      : null;
  const needsLookup =
    matchingBranch === null &&
    detected?.state === "open" &&
    persisted !== null &&
    (persistedStatus?.pr.state === "merged" || persistedStatus?.pr.state === "closed") &&
    gitStatus?.refName === threadBranch &&
    detected.headRef === threadBranch &&
    projectId !== null &&
    input.environmentId !== null;
  const listed = useEnvironmentQuery(
    needsLookup && input.environmentId !== null && projectId !== null && detected
      ? relinkPullRequestList({ environmentId: input.environmentId, projectId, url: detected.url })
      : null,
  );
  const listedMatch =
    detected && listed.isSuccess && !listed.isPending
      ? listed.data?.entries.find((entry) =>
          sourceControlClients.isSameChangeRequest(entry.url, detected.url),
        )
      : undefined;
  const detectedRepository =
    matchingBranch?.repository ??
    listedMatch?.repository ??
    (listed.isSuccess &&
    !listed.isPending &&
    listed.data &&
    listed.data.errors.length === 0 &&
    !listed.data.truncated
      ? projectRepository
      : null);
  const replacement: ThreadLinkedPullRequest | null =
    persisted === null ||
    (persistedStatus?.pr.state !== "merged" && persistedStatus?.pr.state !== "closed") ||
    gitStatus?.refName !== threadBranch ||
    detected?.state !== "open" ||
    detected.headRef !== threadBranch ||
    projectId === null ||
    detectedRepository === null ||
    (persisted.projectId === projectId &&
      persisted.repository.toLowerCase() === detectedRepository.toLowerCase() &&
      persisted.number === detected.number)
      ? null
      : { projectId, repository: detectedRepository, number: detected.number, url: detected.url };

  const relinkKeysRef = useRef(new Map<string, string>());
  const relinkWriteRef = useRef(Promise.resolve());
  useEffect(() => {
    if (serverThreadRef === null) return;
    const threadKey = scopedThreadKey(serverThreadRef);
    if (replacement === null) {
      relinkKeysRef.current.delete(threadKey);
      return;
    }
    const relinkKey = `${replacement.projectId}:${replacement.repository}#${replacement.number}`;
    if (relinkKeysRef.current.get(threadKey) === relinkKey) return;
    relinkKeysRef.current.set(threadKey, relinkKey);
    const openSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      serverThreadRef,
    );
    if (
      openSurface?.kind === "pull-request" &&
      persisted !== null &&
      openSurface.projectId === persisted.projectId &&
      openSurface.repository.toLowerCase() === persisted.repository.toLowerCase() &&
      openSurface.number === persisted.number
    ) {
      useRightPanelStore.getState().openPullRequest(serverThreadRef, replacement);
    }

    relinkWriteRef.current = relinkWriteRef.current.then(async () => {
      if (relinkKeysRef.current.get(threadKey) !== relinkKey) return;
      const result = await updateThreadMetadata({
        environmentId: serverThreadRef.environmentId,
        input: { threadId: serverThreadRef.threadId, linkedPullRequest: replacement },
      });
      if (relinkKeysRef.current.get(threadKey) !== relinkKey) return;
      if (result._tag !== "Failure") return;
      relinkKeysRef.current.delete(threadKey);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to update the thread pull request",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [persisted, replacement, serverThreadRef, updateThreadMetadata]);

  const linked = replacement ?? persisted;
  return {
    linked,
    linkedKey: linked ? JSON.stringify([linked.projectId, linked.repository, linked.number]) : null,
    hasDetail: persisted !== null,
  };
}
