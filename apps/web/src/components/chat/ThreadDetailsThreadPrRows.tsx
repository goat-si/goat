import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { findProjectForChangeRequest } from "@goat/client-runtime/change-request-links";
import { resolveThreadCurrentPullRequestLink } from "@goat/client-runtime/thread-pull-requests";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import type { ScopedThreadRef } from "@goat/contracts";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import { useSupportsMultiplePullRequests } from "../../hooks/useSupportsMultiplePullRequests";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { prStatusIndicator, useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import { ThreadDetailsPrRows } from "./ThreadDetailsPrRows";

/** Whether the rows below have a pull request to show from the thread shell alone. */
export function threadShellHasPullRequest(thread: EnvironmentThreadShell | null): boolean {
  return (
    (thread?.pullRequests.length ?? 0) > 0 ||
    Boolean(thread?.linkedPullRequest) ||
    Boolean(thread?.branchPullRequest)
  );
}

export function ThreadDetailsThreadPrRows({
  threadRef,
  project,
  composerTarget,
}: {
  threadRef: ScopedThreadRef;
  project: EnvironmentProject | null;
  composerTarget?: ComposerThreadTarget | undefined;
}) {
  const thread = useQuietThreadShell(threadRef);
  const supportsMultiple = useSupportsMultiplePullRequests(threadRef.environmentId);
  const currentLink = supportsMultiple
    ? resolveThreadCurrentPullRequestLink(thread?.pullRequests ?? [])
    : null;
  const linked = useLinkedThreadPullRequest(
    threadRef.environmentId,
    thread?.linkedPullRequest,
    true,
    thread?.pullRequests,
    thread?.branchPullRequest,
  );
  const pr = linked?.pr ?? null;
  const stored =
    currentLink ??
    (!supportsMultiple ? thread?.linkedPullRequest : null) ??
    thread?.branchPullRequest;
  const number = currentLink?.number ?? pr?.number ?? stored?.number;
  const url = currentLink?.url ?? pr?.url ?? stored?.url;
  const parsed =
    url === undefined ? undefined : sourceControlClients.parseChangeRequestUrl(url)?.link;
  const host = parsed?.authority ?? parsed?.host;
  const reference =
    stored && url && sourceControlClients.isSameChangeRequest(url, stored.url)
      ? { ...stored, ...(host === undefined ? {} : { host }) }
      : null;
  const projects = useProjects();
  // Merge settings belong to the project holding the linked repository, the thread's own first.
  const rowProject =
    parsed === undefined || (project !== null && findProjectForChangeRequest([project], parsed))
      ? project
      : (findProjectForChangeRequest(
          projects.filter((candidate) => candidate.environmentId === threadRef.environmentId),
          parsed,
        ) ?? project);
  const open = useOpenPrLink(threadRef);
  if (number === undefined || url === undefined) return null;
  return (
    <ThreadDetailsPrRows
      threadRef={threadRef}
      links={thread?.pullRequests ?? []}
      currentLink={currentLink}
      onOpenLink={open}
      environmentId={threadRef.environmentId}
      pr={pr}
      number={number}
      reference={reference}
      status={prStatusIndicator(pr, linked?.sourceControlProvider)}
      project={rowProject}
      label={`#${number}${pr?.title.trim() ? `: ${pr.title}` : ""}`}
      openAriaLabel={url}
      onOpen={(event) => open(event, url)}
      composerTarget={composerTarget}
    />
  );
}
