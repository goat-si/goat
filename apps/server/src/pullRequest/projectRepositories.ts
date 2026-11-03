import type {
  OrchestrationProjectShell,
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
