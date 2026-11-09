import { SourceControlProviderKind } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { SourceControlProviderError, type ChangeRequest } from "@goat/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import type { NormalizedAzureDevOpsPullRequestRecord } from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "@goat/source-control-core/server/SourceControlProvider";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "@goat/source-control-core/server/discovery";

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account !== undefined && account.length > 0) {
    return providerAuth({
      status: "authenticated",
      account,
      host: "dev.azure.com",
    });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("azure-devops"),
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
  // `az --version` starts Python and takes ~6s on Windows, exceeding the default probe timeout.
  probeTimeoutMs: 20_000,
  parseAuth: parseAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

interface AzureDevOpsRemote {
  readonly organization: string | null;
  readonly project: string | null;
  readonly name: string;
}

/**
 * The organization, project, and repository a clone URL names. `az --detect` reads the working
 * directory's git config, which is another project on a fork checkout, so the selected remote
 * has to say which one it means. Azure clone URLs carry no `.git` suffix, so a trailing `.git`
 * is part of the name.
 */
function remoteRepository(remoteUrl: string): AzureDevOpsRemote | null {
  const url = URL.parse(remoteUrl.trim());
  const segments = (url?.pathname ?? remoteUrl.trim()).split(/[/:]/u).flatMap((segment) => {
    if (segment.length === 0) return [];
    try {
      return [decodeURIComponent(segment)];
    } catch {
      return [segment];
    }
  });
  const name = segments.at(-1);
  if (name === undefined || !isSafeArgument(name)) return null;
  const gitIndex = segments.at(-2) === "_git" ? segments.length - 2 : null;
  const project = gitIndex === null ? (segments.at(-2) ?? null) : (segments.at(-3) ?? null);
  if (project !== null && !isSafeArgument(project)) return null;
  const organizationSegment =
    gitIndex === null ? (segments.at(-3) ?? null) : (segments.at(-4) ?? null);
  if (organizationSegment !== null && !isSafeArgument(organizationSegment)) return null;
  const host = url?.hostname.toLowerCase() ?? null;
  // Only an HTTPS clone URL names its organization in the host; the SSH hosts (`vs-ssh.`,
  // `ssh.`) carry it in the path like every other remote.
  const organization =
    (url?.protocol === "https:" || url?.protocol === "http:") &&
    host !== null &&
    host.endsWith(".visualstudio.com")
      ? `https://${host}`
      : organizationSegment === null
        ? null
        : `https://dev.azure.com/${organizationSegment}`;
  return { organization, project, name };
}

/** `az` reads a value starting with `@` as a file and one starting with `-` as an option. */
function isSafeArgument(value: string): boolean {
  return value.length > 0 && !value.startsWith("@") && !value.startsWith("-");
}

function toChangeRequest(summary: NormalizedAzureDevOpsPullRequestRecord): ChangeRequest {
  return {
    provider: SourceControlProviderKind.make("azure-devops"),
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    ...(summary.headSha !== undefined ? { headSha: summary.headSha } : {}),
    state: summary.state,
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt: summary.updatedAt,
    isCrossRepository: summary.isCrossRepository,
  };
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("azure-devops"),
    // Azure lists fork pull requests by source branch with no owner filter, so read a full page.
    headBranchProbe: ({ headSelectors }) => ({
      headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
      limit: 100,
    }),
    listChangeRequests: Effect.fn("AzureDevOpsSourceControlProvider.listChangeRequests")(
      function (input) {
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        return azure
          .listPullRequests({
            cwd: input.cwd,
            headSelector: input.headSelector,
            ...(source !== undefined ? { source } : {}),
            state: input.state,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("azure-devops"),
                  operation: "listChangeRequests",
                  command: error.command,
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.headSelector,
                  ),
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
      },
    ),
    getChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.getChangeRequest")(
      function (input) {
        return azure.getPullRequest(input).pipe(
          Effect.map(toChangeRequest),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "getChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
      },
    ),
    createChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.createChangeRequest")(
      function (input) {
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        return azure
          .createPullRequest({
            cwd: input.cwd,
            baseBranch: input.baseRefName,
            headSelector: input.headSelector,
            ...(source !== undefined ? { source } : {}),
            ...(input.target !== undefined ? { target: input.target } : {}),
            title: input.title,
            bodyFile: input.bodyFile,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("azure-devops"),
                  operation: "createChangeRequest",
                  command: error.command,
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.headSelector,
                  ),
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("AzureDevOpsSourceControlProvider.getRepositoryCloneUrls")(
      function (input) {
        return azure.getRepositoryCloneUrls(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "getRepositoryCloneUrls",
                command: error.command,
                cwd: input.cwd,
                repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.repository,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
      },
    ),
    createRepository: Effect.fn("AzureDevOpsSourceControlProvider.createRepository")(
      function (input) {
        return azure.createRepository(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "createRepository",
                command: error.command,
                cwd: input.cwd,
                repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.repository,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
      },
    ),
    getDefaultBranch: Effect.fn("AzureDevOpsSourceControlProvider.getDefaultBranch")(
      function (input) {
        const remote =
          input.context === undefined ? null : remoteRepository(input.context.remoteUrl);
        if (remote === null) return Effect.succeed(null);
        return azure
          .getDefaultBranch({
            cwd: input.cwd,
            repository: remote.name,
            ...(remote.project === null ? {} : { project: remote.project }),
            ...(remote.organization === null ? {} : { organization: remote.organization }),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("azure-devops"),
                  operation: "getDefaultBranch",
                  command: error.command,
                  cwd: input.cwd,
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
      },
    ),
    checkoutChangeRequest: Effect.fn("AzureDevOpsSourceControlProvider.checkoutChangeRequest")(
      function (input) {
        return azure
          .checkoutPullRequest({
            cwd: input.cwd,
            reference: input.reference,
            ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("azure-devops"),
                  operation: "checkoutChangeRequest",
                  command: error.command,
                  cwd: input.cwd,
                  reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                    input.reference,
                  ),
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
      },
    ),
  });
});
