// @effect-diagnostics effectFnOpportunity:off - test fixture factories and mock services.
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit } from "./testkit/gitRepository.ts";
import { SourceControlProviderKind } from "@goat/contracts";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ChangeRequest, GitPreparePullRequestThreadInput } from "@goat/contracts";

import {
  SourceControlProviderError as SourceControlProviderFailure,
  TextGenerationError,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { SourceControlProvider } from "@goat/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";
import { gitSpawnObserverLayer, type GitSpawnGate } from "./testkit/gitSpawnObserver.ts";

/** A change request the fake host reports. Omitted fields read as an open, undated request. */
export type FakeChangeRequest = Omit<ChangeRequest, "provider" | "state" | "updatedAt"> & {
  readonly state?: ChangeRequest["state"];
  readonly updatedAt?: string;
};

export interface FakeProviderScenario {
  prListGate?: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  /** The kind the fake host reports itself as. */
  kind?: string;
  /** Answers to successive change request listings, whatever their head selector. */
  prListSequence?: ReadonlyArray<ReadonlyArray<FakeChangeRequest>>;
  prListByHeadSelector?: Record<string, ReadonlyArray<FakeChangeRequest>>;
  prListSequenceByHeadSelector?: Record<string, ReadonlyArray<ReadonlyArray<FakeChangeRequest>>>;
  /** The answer to every listing the other lists leave unanswered. */
  prListOtherwise?: ReadonlyArray<FakeChangeRequest>;
  defaultBranch?: string;
  pullRequest?: FakeChangeRequest;
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  failWith?: string;
  failCause?: unknown;
  failAfterCalls?: number;
  /** Check out the pull request head from its pull ref: fast-forward only unless forced. */
  syncCheckoutWithPullHead?: boolean;
  /**
   * The host's `headBranchProbe`. By default the fake probes only bare branch names, a hundred
   * at a time, so tests see GitManager defer to the hook; null leaves the probe to GitManager.
   */
  headBranchProbe?: SourceControlProvider["Service"]["headBranchProbe"] | null;
}

export type FakeProviderCall =
  | {
      readonly operation: "listChangeRequests";
      readonly headSelector: string;
      readonly state: string;
      readonly limit: number | undefined;
    }
  | {
      readonly operation: "createChangeRequest";
      readonly baseRefName: string;
      readonly headSelector: string;
      readonly title: string;
    }
  | { readonly operation: "getChangeRequest"; readonly reference: string }
  | {
      readonly operation: "checkoutChangeRequest";
      readonly reference: string;
      readonly force: boolean;
    }
  | { readonly operation: "getRepositoryCloneUrls"; readonly repository: string }
  | { readonly operation: "getDefaultBranch" };

export const listed = (calls: ReadonlyArray<FakeProviderCall>) =>
  calls.flatMap((call) => (call.operation === "listChangeRequests" ? [call] : []));

export const listedSelectors = (calls: ReadonlyArray<FakeProviderCall>) =>
  listed(calls).map((call) => call.headSelector);

export const created = (calls: ReadonlyArray<FakeProviderCall>) =>
  calls.flatMap((call) =>
    call.operation === "createChangeRequest"
      ? [{ baseRefName: call.baseRefName, headSelector: call.headSelector }]
      : [],
  );

export type FakeGitTextGeneration = TextGeneration.TextGeneration["Service"];

function runGitSyncForFakeCheckout(cwd: string, args: readonly string[]): void {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    env: isolatedGitEnv(),
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new Error(
    `Failed to simulate a host checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
  );
}

export const createBareRemote = Effect.fn("GitManagerTest.createBareRemote")(function* () {
  const remoteDir = yield* makeTempDir("goat-git-remote-");
  yield* runGit(remoteDir, ["init", "--bare"]);
  return remoteDir;
});

export const configureRemote = Effect.fn("GitManagerTest.configureRemote")(function* (
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
) {
  yield* runGit(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
  yield* runGit(cwd, [
    "config",
    "--replace-all",
    `remote.${remoteName}.fetch`,
    `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
  ]);
});

export const configureVisibleRemoteUrlWithLocalRewrite = Effect.fn(
  "GitManagerTest.configureVisibleRemoteUrlWithLocalRewrite",
)(function* (cwd: string, remoteName: string, visibleUrl: string, localRemotePath: string) {
  yield* runGit(cwd, ["config", `remote.${remoteName}.url`, visibleUrl]);
  yield* runGit(cwd, ["config", `url.${localRemotePath}.insteadOf`, visibleUrl]);
});

function createTextGeneration(
  overrides: Partial<FakeGitTextGeneration> = {},
): TextGeneration.TextGeneration["Service"] {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    generateReviewGuide: () => Effect.succeed({ stops: [] }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generatePrContent: (input) =>
      implementation.generatePrContent(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateBranchName: (input) =>
      implementation.generateBranchName(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateThreadTitle: (input) =>
      implementation.generateThreadTitle(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateReviewGuide: (input) => implementation.generateReviewGuide(input),
  };
}

/**
 * A host that answers from the scenario and records what it was asked, so tests assert on the
 * selectors GitManager chose rather than on any host's wire format.
 */
export function createFakeSourceControlProvider(scenario: FakeProviderScenario = {}): {
  service: SourceControlProvider["Service"];
  calls: FakeProviderCall[];
} {
  const kind = SourceControlProviderKind.make(scenario.kind ?? "github");
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const prListQueueByHeadSelector = new Map(
    Object.entries(scenario.prListSequenceByHeadSelector ?? {}).map(([headSelector, values]) => [
      headSelector,
      [...values],
    ]),
  );
  const calls: FakeProviderCall[] = [];

  const record = (cwd: string, call: FakeProviderCall) =>
    Effect.suspend(() => {
      calls.push(call);
      return scenario.failWith && calls.length > (scenario.failAfterCalls ?? 0)
        ? Effect.fail(
            new SourceControlProviderFailure({
              provider: kind,
              operation: call.operation,
              cwd,
              detail: scenario.failWith,
              cause: scenario.failCause,
            }),
          )
        : Effect.void;
    });

  const toChangeRequest = (summary: FakeChangeRequest): ChangeRequest => ({
    ...summary,
    provider: kind,
    state: summary.state ?? "open",
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt:
      summary.updatedAt === undefined
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(summary.updatedAt)),
  });

  const pullRequest = (): FakeChangeRequest =>
    scenario.pullRequest ?? {
      number: 101,
      title: "Pull request",
      url: "https://github.com/pingdotgg/codething-mvp/pull/101",
      baseRefName: "main",
      headRefName: "feature/pull-request",
      state: "open",
    };

  const checkout = (cwd: string, force: boolean) => {
    const headBranch = scenario.pullRequest?.headRefName;
    if (!headBranch) return;
    const existingBranch = NodeChildProcess.spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
      { cwd },
    );
    if (scenario.syncCheckoutWithPullHead) {
      runGitSyncForFakeCheckout(cwd, [
        "fetch",
        "origin",
        `refs/pull/${scenario.pullRequest?.number}/head`,
      ]);
      if (existingBranch.status === 0) {
        runGitSyncForFakeCheckout(cwd, ["checkout", headBranch]);
        runGitSyncForFakeCheckout(
          cwd,
          force ? ["reset", "--hard", "FETCH_HEAD"] : ["merge", "--ff-only", "FETCH_HEAD"],
        );
      } else {
        runGitSyncForFakeCheckout(cwd, ["checkout", "-b", headBranch, "FETCH_HEAD"]);
      }
    } else if (existingBranch.status === 0) {
      runGitSyncForFakeCheckout(cwd, ["checkout", headBranch]);
    } else {
      runGitSyncForFakeCheckout(cwd, ["checkout", "-b", headBranch]);
    }
  };

  const headBranchProbe =
    scenario.headBranchProbe === null
      ? {}
      : {
          headBranchProbe:
            scenario.headBranchProbe ??
            (({ headSelectors }: { readonly headSelectors: ReadonlyArray<string> }) => ({
              headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
              limit: 100,
            })),
        };

  return {
    service: {
      kind,
      ...headBranchProbe,
      listChangeRequests: (input) =>
        record(input.cwd, {
          operation: "listChangeRequests",
          headSelector: input.headSelector,
          state: input.state,
          limit: input.limit,
        }).pipe(
          Effect.map(() =>
            (
              prListQueueByHeadSelector.get(input.headSelector)?.shift() ??
              scenario.prListByHeadSelector?.[input.headSelector] ??
              prListQueue.shift() ??
              scenario.prListOtherwise ??
              []
            ).map(toChangeRequest),
          ),
          Effect.tap(() =>
            scenario.prListGate
              ? Deferred.succeed(scenario.prListGate.started, undefined).pipe(
                  Effect.andThen(Deferred.await(scenario.prListGate.release)),
                )
              : Effect.void,
          ),
        ),
      createChangeRequest: (input) =>
        record(input.cwd, {
          operation: "createChangeRequest",
          baseRefName: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
        }),
      getDefaultBranch: (input) =>
        record(input.cwd, { operation: "getDefaultBranch" }).pipe(
          Effect.map(() => {
            const value = (scenario.defaultBranch ?? "main").trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getChangeRequest: (input) =>
        record(input.cwd, { operation: "getChangeRequest", reference: input.reference }).pipe(
          Effect.map(() => toChangeRequest(pullRequest())),
        ),
      getRepositoryCloneUrls: (input) =>
        record(input.cwd, {
          operation: "getRepositoryCloneUrls",
          repository: input.repository,
        }).pipe(
          Effect.flatMap(() => {
            const repository = input.host ? `${input.host}/${input.repository}` : input.repository;
            const cloneUrls =
              scenario.repositoryCloneUrls?.[repository] ??
              (input.host === "github.com"
                ? scenario.repositoryCloneUrls?.[input.repository]
                : undefined);
            return cloneUrls
              ? Effect.succeed({ nameWithOwner: input.repository, ...cloneUrls })
              : Effect.fail(
                  new SourceControlProviderFailure({
                    provider: kind,
                    operation: "getRepositoryCloneUrls",
                    cwd: input.cwd,
                    detail: `Unexpected repository lookup: ${input.repository}`,
                  }),
                );
          }),
        ),
      createRepository: (input) =>
        Effect.fail(
          new SourceControlProviderFailure({
            provider: kind,
            operation: "createRepository",
            cwd: input.cwd,
            detail: `Unexpected repository create: ${input.repository}`,
          }),
        ),
      checkoutChangeRequest: (input) =>
        record(input.cwd, {
          operation: "checkoutChangeRequest",
          reference: input.reference,
          force: input.force ?? false,
        }).pipe(
          Effect.flatMap(() =>
            Effect.try({
              try: () => checkout(input.cwd, input.force ?? false),
              catch: (cause) =>
                new SourceControlProviderFailure({
                  provider: kind,
                  operation: "checkoutChangeRequest",
                  cwd: input.cwd,
                  detail: "Host checkout failed.",
                  cause,
                }),
            }),
          ),
        ),
    },
    calls,
  };
}

/**
 * Reads a template from the base tree the way a host would, without any host's own lookup
 * rules, so tests see which tree GitManager reads it from.
 */
const readFakeChangeRequestTemplate = Effect.fnUntraced(function* (input: {
  readonly cwd: string;
  readonly treeish: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git
    .execute({
      operation: "GitManager.test.readTemplate",
      cwd: input.cwd,
      args: ["show", `${input.treeish}:.github/pull_request_template.md`],
      allowNonZeroExit: true,
    })
    .pipe(Effect.orDie);
  const template = result.stdout.trim();
  return result.exitCode === 0 && template.length > 0 ? Option.some(template) : Option.none();
});
export function runStackedAction(
  manager: GitManager.GitManager["Service"],
  input: {
    cwd: string;
    action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManager.GitManager["Service"]["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

export function preparePullRequestThread(
  manager: GitManager.GitManager["Service"],
  input: GitPreparePullRequestThreadInput,
) {
  return manager.preparePullRequestThread(input);
}

export function makeManager(input?: {
  providerScenario?: FakeProviderScenario;
  sourceControlProvider?: SourceControlProvider["Service"];
  textGeneration?: Partial<FakeGitTextGeneration>;
  serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  setupScriptRunner?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  gitConfigReads?: string[];
  gitCommands?: string[];
  environment?: NodeJS.ProcessEnv;
  gitSpawnGate?: GitSpawnGate;
  seed?: Effect.Effect<
    void,
    ProjectionStore.ProjectionStoreV2Error | ProjectStore.ProjectStoreV2Error,
    ProjectionStore.ProjectionStoreV2 | ProjectStore.ProjectStoreV2
  >;
}) {
  const { service: fakeProvider, calls: providerCalls } = createFakeSourceControlProvider(
    input?.providerScenario,
  );
  const textGeneration = createTextGeneration(input?.textGeneration);
  const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "goat-git-manager-test-",
  });

  const layerServerSettings = ServerSettings.ServerSettingsService.layerTest(input?.serverSettings);

  const gitCommands = input?.gitCommands;
  const gitSpawnGate = input?.gitSpawnGate;
  const watchesGitSpawns = gitCommands !== undefined || gitSpawnGate !== undefined;
  const layerGitDriverSpawner = watchesGitSpawns
    ? gitSpawnObserverLayer(gitCommands, gitSpawnGate)
    : Layer.empty;
  const gitVcsDriver = input?.gitConfigReads
    ? Layer.effect(
        GitVcsDriver.GitVcsDriver,
        GitVcsDriver.make.pipe(
          Effect.map((service) =>
            GitVcsDriver.GitVcsDriver.of({
              ...service,
              readConfigValue: (cwd, key) =>
                Effect.sync(() => input.gitConfigReads?.push(key)).pipe(
                  Effect.andThen(service.readConfigValue(cwd, key)),
                ),
            }),
          ),
        ),
      )
    : GitVcsDriver.layer;
  const layerVcsDriver = (watchesGitSpawns ? Layer.fresh(gitVcsDriver) : gitVcsDriver).pipe(
    Layer.provide(layerGitDriverSpawner),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(layerServerConfig),
  );
  const layerSourceControlRegistry = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    Effect.gen(function* () {
      const context = yield* Effect.context<GitVcsDriver.GitVcsDriver>();
      return (
        input?.sourceControlProvider ?? {
          ...fakeProvider,
          readChangeRequestTemplate: (template: { cwd: string; treeish: string }) =>
            readFakeChangeRequestTemplate(template).pipe(Effect.provideContext(context)),
        }
      );
    }).pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          resolveLink: (input) => provider.resolveLink?.(input),
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
    ),
  );

  const layerManager = Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, textGeneration),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
    }),
    Layer.succeed(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
      input?.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    layerServerSettings,
  ).pipe(
    Layer.provideMerge(layerSourceControlRegistry),
    Layer.provideMerge(layerVcsDriver),
    Layer.provideMerge(NodeServices.layer),
  );
  const layerStores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  return Effect.gen(function* () {
    const stores = yield* Layer.build(layerStores);
    if (input?.seed !== undefined) {
      yield* input.seed.pipe(Effect.provideContext(stores), Effect.orDie);
    }
    const manager = yield* GitManager.make.pipe(
      Effect.provide(layerManager),
      Effect.provideContext(stores),
    );
    return { manager, providerCalls };
  });
}

export const asThreadId = (threadId: string) => threadId as ThreadId;

export const layerGitManagerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-git-manager-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
