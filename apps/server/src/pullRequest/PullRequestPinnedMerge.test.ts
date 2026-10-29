import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
  type ServerSettings,
} from "@goat/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts/settings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import type { SourceControlProvider } from "@goat/source-control-core/server/SourceControlProvider";
import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";
import type {
  ProviderChangeRequest,
  PullRequestProviderApi,
} from "@goat/source-control-core/server/PullRequestProvider";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

function project(input: {
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

function changeRequest(number: number, updatedAt: string): ProviderChangeRequest {
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

function hostedChangeRequest(body: string, additions = 1) {
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

function makeService(input: {
  readonly settings?: ServerSettings;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
  readonly resolveHandle?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"];
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
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
          get: () => Effect.succeed({} as SourceControlProvider["Service"]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: (options) =>
            Effect.succeed(
              input.projects.filter((project) => options?.projectIds?.includes(project.id) ?? true),
            ),
          getShell: (projectId) =>
            Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: input.resolveRepositoryIdentity ?? (() => Effect.succeed(null)),
        }),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
    (context) => Effect.provideContext(PullRequestService.make, context),
  );
}

it.effect("refuses pinned merges on hosts that cannot enforce the reviewed head", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () => Effect.succeed(hostedChangeRequest("")),
          runAction: () => {
            writes++;
            return Effect.void;
          },
        }),
      ],
    });
    const error = yield* Effect.flip(
      service.runAction({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        action: "merge",
        headSha: "reviewed-head",
      }),
    );
    assert.match(error.message, /head/i);
    assert.strictEqual(writes, 0);
  }),
);

it.effect("passes the reviewed head to a host that enforces it", () =>
  Effect.gen(function* () {
    let seenHead: string | undefined;
    const provider = fakePullRequestProvider(SourceControlProviderKind.make("github"));
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        {
          ...provider,
          capabilities: { ...provider.capabilities, expectedHeadMergeMethods: ["merge"] },
          getChangeRequest: () => Effect.succeed(hostedChangeRequest("")),
          runAction: (input) => {
            seenHead = input.headSha;
            return Effect.void;
          },
        },
      ],
    });
    yield* service.runAction({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      action: "merge",
      headSha: "reviewed-head",
    });
    assert.strictEqual(seenHead, "reviewed-head");
  }),
);
