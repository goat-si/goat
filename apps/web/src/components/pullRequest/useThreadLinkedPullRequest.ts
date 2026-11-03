import {
  type EnvironmentId,
  type ProjectId,
  type RepositoryIdentity,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
  type VcsStatusResult,
} from "@goat/contracts";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { scopedThreadKey, scopeProjectRef } from "@goat/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { useEffect, useRef } from "react";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import { stackedThreadToast, toastManager } from "../ui/toast";

function repositoryForBranch(
  identity: RepositoryIdentity | null | undefined,
  branch: ThreadLinkedPullRequest,
): string | null {
  const parsed = sourceControlClients.parseChangeRequestUrl(branch.url);
  if (identity == null || parsed === null) return null;
  const upstream = sourceControlClients
    .get(identity.provider)
    .isChangeRequestInRepository(identity, parsed.link);
  // Older servers omit the repository and only detect upstream pull requests.
  if (branch.repository == null)
    return upstream ? sourceControlClients.repositorySelector(identity) : null;
  const origin = identity.origin;
  const originUrl = origin?.remoteUrl;
  const displayName = origin?.displayName ?? origin?.canonicalKey.split("/").slice(1).join("/");
  const provider = originUrl ? sourceControlClients.recognizeRemote(originUrl)?.kind : undefined;
  const ownProvider =
    provider ??
    (origin?.canonicalKey.split("/")[0] === identity.canonicalKey.split("/")[0]
      ? identity.provider
      : undefined);
  const name = displayName?.split("/").at(-1);
  const originIdentity =
    origin && originUrl && displayName
      ? {
          canonicalKey: origin.canonicalKey,
          locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: originUrl },
          displayName,
          ...(name === undefined ? {} : { name }),
          ...(ownProvider === undefined ? {} : { provider: ownProvider }),
        }
      : null;
  const matching = upstream
    ? identity
    : originIdentity &&
        sourceControlClients
          .get(originIdentity.provider)
          .isChangeRequestInRepository(originIdentity, parsed.link)
      ? originIdentity
      : null;
  const selector = sourceControlClients.repositorySelector(matching);
  if (selector === null || matching === null) return null;
  const names = [selector, matching.displayName].filter(
    (name): name is string => name !== undefined,
  );
  return names.some((name) => name.toLowerCase() === branch.repository.toLowerCase())
    ? selector
    : null;
}

/** Relink replaced closed/merged requests to the newer open request on the same branch, moving its panel. */
export function useThreadLinkedPullRequest(input: {
  readonly serverThreadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly persisted: ThreadLinkedPullRequest | null;
  readonly projectId: ProjectId | null;
  readonly threadBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
}) {
  const { serverThreadRef, persisted, projectId, threadBranch, gitStatus } = input;
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const persistedStatus = useLinkedThreadPullRequest(input.environmentId, persisted);
  const detected = gitStatus?.pr;
  const branch = useQuietThreadShell(serverThreadRef)?.branchPullRequest;
  const project = useProject(
    input.environmentId !== null && projectId !== null
      ? scopeProjectRef(input.environmentId, projectId)
      : null,
  );
  const detectedRepository =
    detected &&
    branch &&
    projectId !== null &&
    branch.projectId === projectId &&
    branch.number === detected.number &&
    sourceControlClients.isSameChangeRequest(branch.url, detected.url)
      ? repositoryForBranch(project?.repositoryIdentity, branch)
      : null;
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
