import * as Effect from "effect/Effect";
import { isSshRemoteUrl } from "@goat/shared/sourceControl";
import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";
import type { SourceControlProvider } from "@goat/source-control-core/server/SourceControlProvider";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@goat/source-control-core/server/PullRequestProvider";
import {
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@goat/contracts";
import type { ProviderChangeRequest } from "@goat/source-control-core/server/PullRequestProvider";

export function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
  readonly remoteUrl?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? (input.provider === "gitlab" ? "gitlab.com" : "github.com");
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: `${host}/${input.repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: input.remoteUrl ?? `https://${host}/${input.repository}.git`,
            },
            provider: SourceControlProviderKind.make(input.provider ?? "github"),
            displayName: input.repository,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

export function changeRequest(number: number, updatedAt: string): ProviderChangeRequest {
  return {
    number,
    title: `Change request ${number}`,
    url: `https://host/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    reviewRequestLogins: [],
    labels: [],
  };
}

export function hostedChangeRequest(body: string, additions = 1) {
  return {
    ...changeRequest(1, "2026-07-02T00:00:00Z"),
    body,
    additions,
    changedFiles: 2,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    viewerPermissions: {
      actions: ["merge"] as const,
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"] as const,
      requestReviewers: true,
    },
  };
}

export function unusable(
  provider: SourceControlProviderKind,
  reason: "missing-tool" | "unauthenticated",
) {
  return new PullRequestProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}

export const requestFailed = new PullRequestProviderError({
  provider: SourceControlProviderKind.make("github"),
  operation: "listChangeRequests",
  reason: "failed",
  detail: "HTTP 404",
});

export function fakeProvider(
  kind: SourceControlProviderKind,
  overrides: Partial<PullRequestProviderApi> = {},
): PullRequestProviderApi {
  return fakePullRequestProvider(kind, {
    // An open pull request with nothing holding it, which a merge reads first.
    getChangeRequest: () => Effect.succeed(hostedChangeRequest("")),
    ...(kind === "github" ? { mergeMessageRewrite: (message: string) => message } : {}),
    ...(kind === "azure-devops"
      ? { repositoryKey: ({ canonicalKey }: { readonly canonicalKey: string }) => canonicalKey }
      : {}),
    ...overrides,
  });
}

// Like Azure DevOps, whose repository names repeat across organizations and projects.
export const keyedByCanonicalKey = {
  repositoryKey: ({ canonicalKey }: { readonly canonicalKey: string }) => canonicalKey,
};

/** A host whose SSH remotes name an alias, so discovery says which server serves them. */
export const sshAliasHost = {
  resolveRemoteWebHost: ({ cwd, context, resolveContext }) =>
    isSshRemoteUrl(context.remoteUrl)
      ? resolveContext({
          cwd,
          context: {
            ...context,
            provider: { kind: SourceControlProviderKind.make("unknown"), name: "", baseUrl: "" },
          },
        }).pipe(
          Effect.map((resolved) =>
            resolved === null || resolved.provider.kind === "unknown"
              ? null
              : new URL(resolved.provider.baseUrl).host,
          ),
        )
      : Effect.succeed(null),
} as SourceControlProvider["Service"];

export const cloudSessionUrl = "https://claude.ai/code/session_ABC123";
export const cloudInput = {
  projectId: "p1" as ProjectId,
  repository: "https://github.com/acme/web",
  sessionUrl: cloudSessionUrl,
};
export const cloudResult = {
  prUrl: "https://github.com/acme/web/pull/7",
  branch: "claude/result",
  summary: "Changed function.",
};
export const cloudProject = project({
  id: "p1",
  title: "web",
  workspaceRoot: "/fixture/source",
  repository: "acme/web",
});
