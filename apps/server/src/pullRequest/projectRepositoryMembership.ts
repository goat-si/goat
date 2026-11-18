import {
  PullRequestOperationError,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type PullRequestListInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectService from "../project/ProjectService.ts";
import type * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import type * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import { projectRepositories, type ProjectRepository } from "./projectRepositories.ts";

export const listsRepository = (
  candidate: { readonly repository: string; readonly host: string },
  repository: string,
  host: string | undefined,
) =>
  candidate.repository.toLowerCase() === repository.toLowerCase() &&
  (host === undefined || host === candidate.host);

export const readProjectShells = (
  projects: ProjectService.ProjectService["Service"],
  filter: Pick<PullRequestListInput, "projectId" | "projectIds">,
) =>
  (filter.projectId === undefined
    ? projects.listShells(
        filter.projectIds === undefined ? undefined : { projectIds: filter.projectIds },
      )
    : projects.getShell(filter.projectId).pipe(Effect.map(Option.toArray))
  ).pipe(
    Effect.mapError(
      (cause) =>
        new PullRequestOperationError({
          operation: "listProjects",
          detail: "The project list could not be read.",
          cause,
        }),
    ),
  );

export const resolveProjectRepositories = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  identities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  concurrency: number,
) =>
  Effect.forEach(
    projects,
    (project) =>
      project.repositoryIdentity != null
        ? Effect.succeed(project)
        : identities
            .resolve(project.workspaceRoot)
            .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity }))),
    { concurrency },
  ).pipe(Effect.map(projectRepositories));

const githubKind = SourceControlProviderKind.make("github");
const githubHost = sourceControlDefinitions.find(githubKind)?.publicHost;

export function hasAuthoritativeMediaRepository(
  repositories: ReadonlyArray<ProjectRepository>,
  host: string,
  repository: string,
  registry: PullRequestProviderRegistry.PullRequestProviderRegistry["Service"],
): boolean {
  if (host !== githubHost) return false;
  const github = registry.get(githubKind);
  if (github === null || github.servesHost?.(host) === false) return false;
  const key = `${host}/${repository}`;
  return repositories.some(({ identity }) => {
    if (
      identity?.provider !== githubKind ||
      identity.canonicalKey.toLowerCase() !== key ||
      sourceControlDefinitions.repositorySelector(identity)?.toLowerCase() !== repository
    )
      return false;
    const { remoteUrl } = identity.locator;
    const recognized = sourceControlDefinitions.recognizeRemote(remoteUrl);
    // A public GitHub remote names its authority directly. Aliases need provider verification.
    return (
      recognized?.kind === githubKind &&
      recognized.baseUrl === `https://${host}` &&
      sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl).toLowerCase() === key
    );
  });
}
