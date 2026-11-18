import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import type { ServerSettings } from "@goat/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts/settings";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import * as PullRequestService from "./PullRequestService.ts";
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
  type PullRequestReviewCapabilities,
  type PullRequestReviewerCapabilities,
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
const sshAliasHost = {
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

export function makeService(input: {
  readonly settings?: ServerSettings;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
  readonly resolveHandle?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"];
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
  readonly onProjectRead?: () => void;
}) {
  // Build in the test scope; per-call Effect.provide would close the marks database on service acquisition.
  return Effect.flatMap(
    Layer.build(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(input.settings ?? DEFAULT_SERVER_SETTINGS),
        }),
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders(input.providers),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle:
            input.resolveHandle ?? (() => Effect.die("Unexpected provider refinement")),
          get: (kind) =>
            Effect.succeed(
              kind === "forgejo" ? sshAliasHost : ({} as SourceControlProvider["Service"]),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: (options) =>
            Effect.sync(() => {
              input.onProjectRead?.();
              return input.projects.filter(
                (project) => options?.projectIds?.includes(project.id) ?? true,
              );
            }),
          getShell: (projectId) =>
            Effect.sync(() => {
              input.onProjectRead?.();
              return Option.fromNullishOr(input.projects.find((p) => p.id === projectId));
            }),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: input.resolveRepositoryIdentity ?? (() => Effect.succeed(null)),
        }),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
    (context) => Effect.provideContext(PullRequestService.make, context),
  );
}

export const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};
export const FULL_REVIEWERS: PullRequestReviewerCapabilities = {
  request: true,
  listCandidates: true,
};

export const environmentViewedProvider = (
  revisions: Map<string, string>,
  asked: Array<ReadonlyArray<string>>,
  unreadable: ReadonlySet<string> = new Set(),
) =>
  fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge"],
      mergeMethods: ["merge"],
      search: true,
      reactions: true,
      viewedFiles: "environment",
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
    },
    getFilesViewed: () => Effect.die("the host keeps no marks of its own"),
    setFilesViewed: () => Effect.die("the host keeps no marks of its own"),
    getChangeRequest: () => Effect.succeed(hostedChangeRequest("")),
    getChangeRequestSummary: () => Effect.succeed(changeRequest(1, "2026-07-02T00:00:00Z")),
    getFileRevisions: (input) => {
      asked.push(input.paths);
      return Effect.succeed({
        revisions: new Map(
          input.paths.flatMap((path) =>
            unreadable.has(path) ? [] : [[path, revisions.get(path) ?? ""] as const],
          ),
        ),
      });
    },
  });

export const environmentViewedService = (
  revisions: Map<string, string>,
  asked: Array<ReadonlyArray<string>>,
  unreadable: ReadonlySet<string> = new Set(),
) =>
  makeService({
    projects: [
      project({
        id: "p1",
        title: "on gitlab",
        workspaceRoot: "/a",
        repository: "group/project",
        provider: SourceControlProviderKind.make("gitlab"),
      }),
    ],
    providers: [environmentViewedProvider(revisions, asked, unreadable)],
  });
