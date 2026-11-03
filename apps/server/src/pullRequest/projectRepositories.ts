import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestRef,
  RepositoryIdentity,
  SourceControlProviderInfo,
} from "@goat/contracts";
import { isSshRemoteUrl } from "@goat/shared/sourceControl";

import { ownRepositoryIdentity } from "../project/RepositoryIdentityResolver.ts";

/** A repository whose change requests a project lists. */
export interface ProjectRepository {
  readonly project: OrchestrationProjectShell;
  readonly identity: RepositoryIdentity | null | undefined;
  /** The upstream a fork was made from, listed only when asked for. */
  readonly upstream: boolean;
}

/**
 * A fork lists its own repository, and its upstream after every project's own, so a repository one
 * project works in is never hidden as another project's upstream.
 */
export function projectRepositories(
  projects: ReadonlyArray<OrchestrationProjectShell>,
): ReadonlyArray<ProjectRepository> {
  const own: ProjectRepository[] = [];
  const upstream: ProjectRepository[] = [];
  for (const project of projects) {
    const identity = project.repositoryIdentity;
    const fork = identity ? ownRepositoryIdentity(identity) : null;
    if (fork === null) {
      own.push({ project, identity, upstream: false });
      continue;
    }
    own.push({ project, identity: fork, upstream: false });
    upstream.push({ project, identity, upstream: true });
  }
  return [...own, ...upstream];
}

export const remoteHostKey = (recognized: SourceControlProviderInfo, remoteUrl: string) =>
  `${recognized.baseUrl}\n${isSshRemoteUrl(remoteUrl) ? "ssh" : "web"}`;

interface ListedRepository {
  readonly cursorKey: string;
  readonly project: { readonly id: ProjectId };
  readonly repository: string;
  readonly host: string;
  readonly upstream: boolean;
}

export interface StatTarget<Listed extends ListedRepository> {
  readonly project: Listed;
  readonly number: number;
  /** Every project whose rows asked for this change request. */
  readonly projectIds: ReadonlyArray<ProjectId>;
}

/**
 * The listed repository that reads each stats ref, one read per change request. A repository the
 * listing gave to another project (a worktree, or one project's origin that is another's upstream)
 * still answers for the project whose rows asked.
 */
export function statTargets<Listed extends ListedRepository>(
  listed: ReadonlyArray<Listed>,
  refs: ReadonlyArray<PullRequestRef>,
): ReadonlyArray<StatTarget<Listed>> {
  const name = (repository: string) => repository.trim().toLowerCase();
  const targets = new Map<string, { project: Listed; number: number; projectIds: ProjectId[] }>();
  for (const ref of refs) {
    const repository = name(ref.repository);
    const host = ref.host?.trim().toLowerCase();
    const elsewhere = listed.filter(
      (item) => name(item.repository) === repository && (host === undefined || item.host === host),
    );
    const mine = elsewhere.filter((item) => item.project.id === ref.projectId);
    // Without a host, a fork's own repository answers before a same-path upstream on another
    // host, and a name other projects list on two hosts cannot say which one was meant.
    const project =
      mine.find((item) => !item.upstream) ??
      mine[0] ??
      (new Set(elsewhere.map((item) => item.host)).size === 1 ? elsewhere[0] : undefined);
    if (project === undefined) continue;
    const key = `${project.cursorKey} ${ref.number}`;
    const held = targets.get(key);
    if (held === undefined)
      targets.set(key, { project, number: ref.number, projectIds: [ref.projectId] });
    else if (!held.projectIds.includes(ref.projectId)) held.projectIds.push(ref.projectId);
  }
  return [...targets.values()];
}

/** An HTTP remote names its server's web host, port included. */
export function httpRemoteHost(remoteUrl: string): string | null {
  try {
    const remote = new URL(remoteUrl);
    return remote.protocol === "http:" || remote.protocol === "https:"
      ? remote.host.toLowerCase()
      : null;
  } catch {
    return null;
  }
}
