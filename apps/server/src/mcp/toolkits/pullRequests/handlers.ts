import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type SourceControlProviderKind,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@goat/contracts";
import { canonicalizeGitCafePullRequestUrl } from "@goat/source-control-definitions/registry";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import { clipText, fitItems, READ_BUDGET_BYTES } from "./readBudget.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import { pullRequestSyncKey } from "../../../pullRequest/pullRequestSyncKey.ts";
import { sourceControlDefinitions } from "../../../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../../../sourceControl/threadPullRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type ListThreadPullRequestsResult,
  PullRequestLinkFailedError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUrlUnavailableError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestNotOpenError,
  type PullRequestTargetInput,
  PullRequestWatchFailedError,
  PullRequestWatchFromSubagentError,
  PullRequestThreadNotFoundError,
  PullRequestThreadRequiredError,
  PullRequestGuideFailedError,
  PullRequestProjectNotFoundError,
  PullRequestReadFailedError,
  PullRequestSearchTooLargeError,
  PullRequestRepositoryAmbiguousError,
  PullRequestsToolkit,
  type ThreadPullRequestEntry,
} from "./tools.ts";

interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function projectHostAndProvider(project: OrchestrationProjectShell | undefined): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    kind,
  };
}

const resolveTarget = Effect.fn("PullRequestsToolkit.resolveTarget")(function* (
  input: PullRequestTargetInput,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(input.url)?.link;
    if (parsed === undefined) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return {
      ...normalizeThreadPullRequestKey(parsed),
      url: canonicalizeGitCafePullRequestUrl(input.url),
    } satisfies ResolvedTarget;
  }
  if (input.repository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  const projectHost = projectHostAndProvider(project);
  const host = (input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  const repository = input.repository.toLowerCase();
  // Without a URL, a public forge host says what shape its change request URLs take;
  // any other host is taken to run the project's own forge.
  const recognizedKind = sourceControlDefinitions.recognizeRemote(`https://${host}`)?.kind;
  const kind =
    sourceControlDefinitions.findByPublicHost(host)?.kind ??
    (recognizedKind === "gitcafe" ? recognizedKind : projectHost.kind);
  const url =
    kind === null
      ? null
      : sourceControlDefinitions.get(kind).changeRequestUrl({
          host,
          repository,
          number: input.number,
          remoteUrl: project?.repositoryIdentity?.locator.remoteUrl,
        });
  if (url === null) {
    return yield* new PullRequestUrlUnavailableError({});
  }
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url: canonicalizeGitCafePullRequestUrl(url),
  } satisfies ResolvedTarget;
});

function entryOf(
  link: ThreadPullRequestLink,
  chains: ReturnType<typeof resolveThreadPullRequestChains>,
): ThreadPullRequestEntry {
  const key = threadPullRequestKeyOf(link);
  let stack: ThreadPullRequestEntry["stack"] = null;
  for (const chain of chains) {
    if (chain.layers.length < 2) continue;
    const index = chain.layers.findIndex((layer) => threadPullRequestKeyOf(layer) === key);
    if (index !== -1) {
      stack = { kind: chain.kind, position: chain.depths[index]! + 1, size: chain.layers.length };
      break;
    }
  }
  return {
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    watching: link.watch !== undefined,
    state: link.snapshot?.state ?? null,
    title: link.snapshot?.title ?? null,
    headBranch: link.snapshot?.headBranch ?? null,
    baseBranch: link.snapshot?.baseBranch ?? null,
    isDraft: link.snapshot?.isDraft ?? null,
    stack,
  };
}

export function listThreadPullRequests(
  thread: Pick<OrchestrationV2ThreadShell, "pullRequests">,
): ListThreadPullRequestsResult {
  const chains = resolveThreadPullRequestChains(thread.pullRequests ?? []);
  return {
    pullRequests: visibleThreadPullRequests(thread.pullRequests ?? []).map((link) =>
      entryOf(link, chains),
    ),
    chains: chains.map((chain) => ({
      kind: chain.kind,
      numbers: chain.layers.map((layer) => layer.number),
    })),
  };
}

/** A project's own repository as a pull request key: host with its port, the full path. */
function repositoryKeyOf(project: OrchestrationProjectShell) {
  return project.repositoryIdentity == null
    ? null
    : pullRequestSyncKey(
        {
          projectId: project.id,
          repository: sourceControlDefinitions.repositorySelector(project.repositoryIdentity) ?? "",
          number: 1,
        },
        project.repositoryIdentity,
      );
}

function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // Match the guide service's host-level repository key, including Azure DevOps org/project/_git/repo.
  const matches = (project: OrchestrationProjectShell) => {
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      project.repositoryIdentity ?? undefined,
    );
    const projectKey = repositoryKeyOf(project);
    return (
      own !== null &&
      projectKey !== null &&
      own.host === projectKey.host &&
      own.repository === projectKey.repository
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

/** Default rows a search returns in total. */
const SEARCH_LIMIT = 10;
// Room for identity, author and counts beside the lists that share the budget.
const ACTIVITY_LIST_BYTES = READ_BUDGET_BYTES - 16 * 1024;

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
  const pullRequests = yield* PullRequestService.PullRequestService;

  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("PullRequestsToolkit.requireThread")(function* (
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestListFailedError
      | typeof PullRequestWatchFailedError,
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new PullRequestThreadRequiredError();
    }
    const thread = yield* engine.getThreadShell(threadId).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.mapError((cause) => new Failure({ cause })),
    );
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new PullRequestThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  const projectOf = (
    thread: OrchestrationV2ThreadShell,
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestWatchFailedError,
  ) =>
    projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new Failure({ cause })),
    );

  const dispatchFailure =
    (
      Failure:
        | typeof PullRequestLinkFailedError
        | typeof PullRequestUnlinkFailedError
        | typeof PullRequestWatchFailedError,
    ) =>
    <E>(
      cause: Cause.Cause<E>,
    ): Effect.Effect<
      never,
      PullRequestLinkFailedError | PullRequestUnlinkFailedError | PullRequestWatchFailedError
    > =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (
    input: PullRequestTargetInput,
    watching: boolean,
  ) {
    const thread = yield* requireThread(PullRequestWatchFailedError, input.threadId);
    const project = yield* projectOf(thread, PullRequestWatchFailedError);
    const target = yield* resolveTarget(input, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    if (watching && thread.lineage.relationshipToParent === "subagent") {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    if (watching && before?.snapshot?.state === "merged") {
      return yield* new PullRequestNotOpenError({ state: "merged" });
    }
    yield* engine
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: yield* commandId("mcp-pr-watch", thread.id),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
      })
      .pipe(Effect.catchCause(dispatchFailure(PullRequestWatchFailedError)));
    const after = yield* requireThread(PullRequestWatchFailedError, thread.id);
    return {
      host: target.host,
      repository: target.repository,
      number: target.number,
      url: target.url,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching: before?.watch !== undefined,
    };
  });

  const locateAll = Effect.fn("PullRequestsToolkit.locateAll")(function* (
    targets: ReadonlyArray<Omit<PullRequestTargetInput, "threadId">>,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const callerThread =
      scope.thread === undefined
        ? undefined
        : yield* engine.getThreadShell(scope.thread.threadId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((shell) => shell ?? undefined),
          );
    const known = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    const callerProject = known.find((project) => project.id === callerThread?.projectId);
    // A pull request named by repository builds its URL through the project that holds it, which
    // need not be the caller's. Without a host, that is the one project whose remote matches.
    // Whether host names the project's repository host, under any spelling the normalizer folds
    // (an Azure DevOps org.visualstudio.com host carries its organization, dev.azure.com its path).
    const namesHost = (project: OrchestrationProjectShell, host: string) => {
      const key = repositoryKeyOf(project);
      if (key === null) return false;
      const [, ...withoutOwner] = key.repository.split("/");
      return [key.repository, withoutOwner.join("/")].some((repository) => {
        const probe = normalizeThreadPullRequestKey({ host, repository, number: key.number });
        return probe.host === key.host && probe.repository === key.repository;
      });
    };
    const holds = (project: OrchestrationProjectShell, repository: string, host?: string) => {
      const own = projectHostAndProvider(project).host;
      if (own === null) return false;
      // A full path names its repository on the host given, so it is normalized there; only a
      // short name needs the project's own host to expand it.
      if (repository.includes("/")) {
        const key = repositoryKeyOf(project);
        const target = normalizeThreadPullRequestKey({ host: host ?? own, repository, number: 1 });
        return key !== null && target.host === key.host && target.repository === key.repository;
      }
      return (
        (host === undefined || namesHost(project, host)) &&
        projectForPullRequest([project], { host: own, repository }, undefined) !== undefined
      );
    };
    const routed = Effect.fn("PullRequestsToolkit.routeTarget")(function* (
      input: PullRequestTargetInput,
    ) {
      if (input.url !== undefined || input.repository === undefined)
        return { input, project: callerProject };
      const { repository } = input;
      // Checkouts of one repository share its pull request key; two repositories that answer to
      // the same short name are ambiguous whoever calls, with or without host.
      const holders = known.filter((project) => holds(project, repository, input.host));
      const keys = new Map(
        holders.flatMap((project) => {
          const key = repositoryKeyOf(project);
          return key === null ? [] : [[`${key.host}/${key.repository}`, key] as const];
        }),
      );
      if (keys.size > 1) return yield* new PullRequestRepositoryAmbiguousError({ repository });
      const [first] = holders;
      const [key] = keys.values();
      if (first === undefined || key === undefined) return { input, project: callerProject };
      const holder =
        callerProject !== undefined && holders.includes(callerProject) ? callerProject : first;
      // The holder's own host and full path, so a short Azure DevOps name builds its
      // org/project/_git URL.
      return { input: { ...input, host: key.host, repository: key.repository }, project: holder };
    });
    return yield* Effect.forEach(targets, (input) =>
      routed(input).pipe(
        Effect.flatMap((route) => resolveTarget(route.input, route.project)),
        Effect.map((target) => ({
          input,
          target,
          project: projectForPullRequest(known, target, callerProject),
          failure: null,
          error: null,
        })),
        Effect.catch((error) =>
          Effect.succeed({
            input,
            target: null,
            project: undefined,
            failure: error.message,
            error,
          }),
        ),
      ),
    );
  });

  const guideReference = (
    project: OrchestrationProjectShell,
    target: { readonly host: string; readonly repository: string; readonly number: number },
  ) => ({
    projectId: project.id,
    host: target.host,
    repository: target.repository,
    number: target.number,
  });

  const guideFailureDetail = (error: { readonly message: string }) =>
    "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  /** A target the caller named, resolved to the project checkout that can read it. */
  const locateOne = Effect.fn("PullRequestsToolkit.locateOne")(function* (
    input: Omit<PullRequestTargetInput, "threadId">,
  ) {
    const [entry] = yield* locateAll([input]);
    // An unreadable target is the caller's input, so its own refusal comes back unchanged.
    if (entry !== undefined && entry.target === null && entry.error !== null)
      return yield* entry.error;
    if (entry === undefined || entry.target === null || entry.project === undefined)
      return yield* new PullRequestProjectNotFoundError({
        repository: entry?.target.repository ?? input.repository ?? "",
      });
    return { target: entry.target, ref: guideReference(entry.project, entry.target) };
  });

  const readFailure = (error: { readonly message: string }) =>
    new PullRequestReadFailedError({ detail: guideFailureDetail(error), cause: error });

  const identityOf = (target: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
    readonly url: string;
  }) => ({
    host: target.host,
    repository: target.repository,
    number: target.number,
    url: target.url,
  });

  return {
    link_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const next =
          thread.lineage.relationshipToParent === "subagent"
            ? {
                next: "End your reply with: PR <full URL>, head <SHA>, checks and reviews <state>.",
              }
            : {};
        const project = yield* projectOf(thread, PullRequestLinkFailedError);
        const target = yield* resolveTarget(input, project);
        const existing = threadPullRequestsOf(thread).find((link) =>
          threadPullRequestKeysEqual(link, target),
        );
        if (existing && existing.source !== "stack-dismissed")
          return { ...target, alreadyLinked: true, ...next };
        const alreadyLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: yield* commandId("mcp-pr-link", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
            url: target.url,
            source: "agent",
          })
          .pipe(
            Effect.as(false),

            Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)),
          );
        return { ...target, alreadyLinked, ...next };
      }),
    ),
    unlink_pull_request: McpToolAccess.destructive(
      writesThread((input) =>
        Effect.gen(function* () {
          const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
          const project = yield* projectOf(thread, PullRequestUnlinkFailedError);
          const target = yield* resolveTarget(input, project);
          if (
            !threadPullRequestsOf(thread).some((link) => threadPullRequestKeysEqual(link, target))
          )
            return {
              host: target.host,
              repository: target.repository,
              number: target.number,
              wasLinked: false,
            };
          const wasLinked = yield* engine
            .dispatch({
              type: "thread.pull-request.unlink",
              commandId: yield* commandId("mcp-pr-unlink", thread.id),
              threadId: thread.id,
              host: target.host,
              repository: target.repository,
              number: target.number,
            })
            .pipe(
              Effect.as(true),

              Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError)),
            );
          return {
            host: target.host,
            repository: target.repository,
            number: target.number,
            wasLinked,
          };
        }),
      ),
    ),
    list_thread_pull_requests: McpToolAccess.reads((input) =>
      requireThread(PullRequestListFailedError, input.threadId).pipe(
        Effect.map(listThreadPullRequests),
      ),
    ),
    watch_pull_request: writesThread((input) => setWatching(input, true)),
    unwatch_pull_request: writesThread((input) => setWatching(input, false)),
    write_pull_request_guides: McpToolAccess.writesWithCapability(
      (input) =>
        Effect.gen(function* () {
          const located = yield* locateAll(input.pullRequests);
          yield* McpToolAccess.admit(input);
          const guides = yield* Effect.forEach(
            located,
            (entry) =>
              Effect.gen(function* () {
                if (entry.target === null) {
                  return {
                    host: entry.input.host ?? "",
                    repository: entry.input.repository ?? "",
                    number: entry.input.number ?? 0,
                    url: entry.input.url ?? "",
                    outcome: "failed" as const,
                    detail: entry.failure,
                  };
                }
                const identity = {
                  host: entry.target.host,
                  repository: entry.target.repository,
                  number: entry.target.number,
                  url: entry.target.url,
                };
                if (entry.project === undefined) {
                  return {
                    ...identity,
                    outcome: "failed" as const,
                    detail: new PullRequestProjectNotFoundError({
                      repository: entry.target.repository,
                    }).message,
                  };
                }
                return yield* reviewGuides
                  .generate(guideReference(entry.project, entry.target))
                  .pipe(
                    Effect.map((result) => ({
                      ...identity,
                      outcome: result.started ? ("started" as const) : ("running" as const),
                      detail: null,
                    })),
                    Effect.catch((error) =>
                      Effect.succeed({
                        ...identity,
                        outcome: "failed" as const,
                        detail: guideFailureDetail(error),
                      }),
                    ),
                  );
              }),
            { concurrency: 4 },
          );
          return { guides };
        }),
      { admission: "handler" },
    ),
    read_pull_request_guide: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const [entry] = yield* locateAll([input]);
        if (entry !== undefined && entry.target === null) {
          return yield* new PullRequestGuideFailedError({ detail: entry.failure ?? "" });
        }
        if (entry === undefined || entry.target === null || entry.project === undefined) {
          return yield* new PullRequestProjectNotFoundError({
            repository: entry?.target.repository ?? input.repository ?? "",
          });
        }
        const result = yield* reviewGuides.get(guideReference(entry.project, entry.target)).pipe(
          Effect.mapError(
            (error) =>
              new PullRequestGuideFailedError({
                detail: guideFailureDetail(error),
                cause: error,
              }),
          ),
        );
        return {
          host: entry.target.host,
          repository: entry.target.repository,
          number: entry.target.number,
          url: entry.target.url,
          guide: result.guide,
          run: result.run,
          currentHeadSha: result.currentHeadSha,
          stale:
            result.guide !== null &&
            result.currentHeadSha !== null &&
            result.guide.headSha !== result.currentHeadSha,
        };
      }),
    ),
    goat_pull_request_read: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locateOne(input);
        // Fresh like the pull request view, not the held copy a list row may show.
        const pullRequest = yield* pullRequests
          .detail({ ...ref, allowStale: false })
          .pipe(Effect.mapError(readFailure));
        return { ...identityOf(target), pullRequest };
      }),
    ),
    goat_pull_request_checks: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locateOne(input);
        const checks = yield* pullRequests.checks(ref).pipe(Effect.mapError(readFailure));
        return { ...identityOf(target), checks };
      }),
    ),
    goat_pull_request_activity: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locateOne(input);
        const activity = yield* pullRequests.activity(ref).pipe(Effect.mapError(readFailure));
        // Every list shares one budget, in this order; each says how many it left out.
        let left = ACTIVITY_LIST_BYTES;
        const take = <A>(items: ReadonlyArray<A>) => {
          const fit = fitItems(items, left);
          left -= fit.used;
          return fit;
        };
        const reviewers = take(activity.reviewers ?? []);
        const comments = take(activity.comments);
        const reviewThreads = take(activity.reviewThreads);
        const commits = take(activity.commits);
        const reactions = take(activity.reactions ?? []);
        return {
          ...identityOf(target),
          activity: {
            ...activity,
            ...(activity.reviewers === undefined ? {} : { reviewers: reviewers.kept }),
            comments: comments.kept,
            reviewThreads: reviewThreads.kept,
            commits: commits.kept,
            ...(activity.reactions === undefined ? {} : { reactions: reactions.kept }),
          },
          commentsOmitted: comments.omitted,
          reviewThreadsOmitted: reviewThreads.omitted,
          commitsOmitted: commits.omitted,
          reviewersOmitted: reviewers.omitted,
          reactionsOmitted: reactions.omitted,
        };
      }),
    ),
    goat_pull_request_review_thread: McpToolAccess.reads(({ threadId, cursor, ...input }) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locateOne(input);
        const page = yield* pullRequests
          .threadComments({ ...ref, threadId, cursor })
          .pipe(Effect.mapError(readFailure));
        const comments = fitItems(page.comments, READ_BUDGET_BYTES);
        return {
          ...identityOf(target),
          comments: comments.kept,
          nextCursor: page.nextCursor,
          commentsOmitted: comments.omitted,
        };
      }),
    ),
    goat_pull_request_file: McpToolAccess.reads(
      ({ commit, changeType, oldPath, newPath, ...input }) =>
        Effect.gen(function* () {
          const { target, ref } = yield* locateOne(input);
          const file = yield* pullRequests
            .diffFileContents({
              ...ref,
              ...(commit === undefined ? {} : { commit }),
              changeType,
              oldPath,
              newPath,
            })
            .pipe(Effect.mapError(readFailure));
          const before = clipText(file.oldContents, READ_BUDGET_BYTES);
          const after = clipText(file.newContents, READ_BUDGET_BYTES);
          return {
            ...identityOf(target),
            oldContents: before.text,
            newContents: after.text,
            oldTruncated: before.truncated,
            newTruncated: after.truncated,
          };
        }),
    ),
    goat_pull_request_search: McpToolAccess.reads(({ limit = SEARCH_LIMIT, ...input }) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("pull-requests");
        const result = yield* pullRequests
          .list({ ...input, limit })
          .pipe(Effect.mapError(readFailure));
        // Cursors are per repository, so cutting rows here would skip them on the next page.
        const page = {
          entries: result.entries,
          errors: result.errors,
          truncated: result.truncated,
          nextCursors: result.nextCursors,
        };
        if (fitItems([page], READ_BUDGET_BYTES).omitted > 0)
          return yield* new PullRequestSearchTooLargeError({});
        return page;
      }),
    ),
    goat_pull_request_stats: McpToolAccess.reads(({ pullRequests: targets }) =>
      Effect.gen(function* () {
        const refs = yield* Effect.forEach(targets, (target) =>
          locateOne(target).pipe(Effect.map((located) => located.ref)),
        );
        return yield* pullRequests.listStats({ refs }).pipe(Effect.mapError(readFailure));
      }),
    ),
    goat_pull_request_filter_options: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("pull-requests");
        return yield* pullRequests.filterOptions(input).pipe(Effect.mapError(readFailure));
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(PullRequestsToolkit, make);
