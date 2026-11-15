import * as Effect from "effect/Effect";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@goat/source-control-core/server/PullRequestProvider";

export function withRateLimitBackoff(
  api: PullRequestProviderApi,
  host: string,
  limits: SourceControlRateLimit.SourceControlRateLimit["Service"],
  options?: { readonly viewerAllowsPause: boolean },
): PullRequestProviderApi {
  const key = { provider: api.kind, host };
  const protect = <A>(
    operation: string,
    effect: Effect.Effect<A, PullRequestProviderError>,
    alwaysInteractive: boolean,
  ) =>
    SourceControlRateLimit.Interactive.pipe(
      Effect.map((callerInteractive) => alwaysInteractive || callerInteractive),
      Effect.flatMap((allowPaused) =>
        limits.check(key, allowPaused ? { allowPaused: true } : undefined).pipe(
          Effect.mapError(
            (error) =>
              new PullRequestProviderError({
                provider: api.kind,
                operation,
                reason: "rate-limited",
                detail: error.detail,
                retryAt: error.retryAt,
                cause: error,
              }),
          ),
          Effect.flatMap((lease) =>
            effect.pipe(
              Effect.provideService(SourceControlRateLimit.Interactive, allowPaused),
              Effect.tap(() => limits.recordSuccess({ ...key, lease })),
              Effect.tapError((error) =>
                error.reason === "rate-limited"
                  ? limits.recordRateLimit({
                      ...key,
                      lease,
                      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
                    })
                  : Effect.void,
              ),
            ),
          ),
        ),
      ),
    );
  const wrap =
    <Args extends ReadonlyArray<unknown>, A>(
      operation: string,
      call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
      alwaysInteractive = false,
    ) =>
    (...args: Args) =>
      protect(operation, call(...args), alwaysInteractive);
  const interactive = <Args extends ReadonlyArray<unknown>, A>(
    operation: string,
    call: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
  ) => wrap(operation, call, true);

  const wrapped = {
    kind: api.kind,
    capabilities: api.capabilities,
    ...(api.mergeMessageRewrite === undefined
      ? {}
      : { mergeMessageRewrite: api.mergeMessageRewrite }),
    ...(api.unavailableRequirement === undefined
      ? {}
      : { unavailableRequirement: api.unavailableRequirement }),
    ...(api.repositoryKey === undefined ? {} : { repositoryKey: api.repositoryKey }),
    ...(api.servesHost === undefined ? {} : { servesHost: api.servesHost }),
    ...(api.readsPublicHostWithoutCheckout === undefined
      ? {}
      : { readsPublicHostWithoutCheckout: api.readsPublicHostWithoutCheckout }),
    ...(api.batchesReads === undefined ? {} : { batchesReads: api.batchesReads }),
    getViewer:
      options?.viewerAllowsPause === true
        ? interactive("getViewer", api.getViewer)
        : wrap("getViewer", api.getViewer),
    ...(api.getRoutingIdentity === undefined ? {} : { getRoutingIdentity: api.getRoutingIdentity }),
    ...(api.withVerifiedCredential === undefined
      ? {}
      : { withVerifiedCredential: api.withVerifiedCredential }),
    ...(api.findCloudSessionPullRequest === undefined
      ? {}
      : {
          findCloudSessionPullRequest: wrap(
            "findCloudSessionPullRequest",
            api.findCloudSessionPullRequest,
          ),
        }),
    listChangeRequests: wrap("listChangeRequests", api.listChangeRequests),
    ...(api.listChangeRequestsAcross === undefined
      ? {}
      : {
          listChangeRequestsAcross: wrap("listChangeRequestsAcross", api.listChangeRequestsAcross),
        }),
    ...(api.listChangeRequestStats === undefined
      ? {}
      : {
          listChangeRequestStats: wrap("listChangeRequestStats", api.listChangeRequestStats),
        }),
    getChangeRequest: wrap("getChangeRequest", api.getChangeRequest),
    ...(api.forgetChangeRequestReads === undefined
      ? {}
      : { forgetChangeRequestReads: api.forgetChangeRequestReads }),
    ...(api.getChangeRequestPreview === undefined
      ? {}
      : { getChangeRequestPreview: wrap("getChangeRequestPreview", api.getChangeRequestPreview) }),
    ...(api.getChangeRequestChecks === undefined
      ? {}
      : { getChangeRequestChecks: wrap("getChangeRequestChecks", api.getChangeRequestChecks) }),
    ...(api.getChangeRequestSummary === undefined
      ? {}
      : {
          getChangeRequestSummary: wrap("getChangeRequestSummary", api.getChangeRequestSummary),
        }),
    ...(api.getChangeRequestStack === undefined
      ? {}
      : { getChangeRequestStack: wrap("getChangeRequestStack", api.getChangeRequestStack) }),
    ...(api.getChangeRequestWatchFingerprint === undefined
      ? {}
      : {
          getChangeRequestWatchFingerprint: wrap(
            "getChangeRequestWatchFingerprint",
            api.getChangeRequestWatchFingerprint,
          ),
        }),
    getChangeRequestActivity: wrap("getChangeRequestActivity", api.getChangeRequestActivity),
    ...(api.getReviewThreadComments === undefined
      ? {}
      : {
          getReviewThreadComments: wrap("getReviewThreadComments", api.getReviewThreadComments),
        }),
    getViewerPermissions: interactive("getViewerPermissions", api.getViewerPermissions),
    getDiff: wrap("getDiff", api.getDiff),
    ...(api.getDiffFilePaths === undefined
      ? {}
      : { getDiffFilePaths: wrap("getDiffFilePaths", api.getDiffFilePaths) }),
    ...(api.getDiffFileContents === undefined
      ? {}
      : { getDiffFileContents: wrap("getDiffFileContents", api.getDiffFileContents) }),
    ...(api.getFilesViewed === undefined
      ? {}
      : { getFilesViewed: wrap("getFilesViewed", api.getFilesViewed) }),
    ...(api.getFileStats === undefined
      ? {}
      : { getFileStats: wrap("getFileStats", api.getFileStats) }),
    ...(api.setFilesViewed === undefined
      ? {}
      : { setFilesViewed: interactive("setFilesViewed", api.setFilesViewed) }),
    ...(api.getFileRevisions === undefined
      ? {}
      : { getFileRevisions: wrap("getFileRevisions", api.getFileRevisions) }),
    runAction: interactive("runAction", api.runAction),
    ...(api.updateChangeRequest === undefined
      ? {}
      : {
          updateChangeRequest: interactive("updateChangeRequest", api.updateChangeRequest),
        }),
    comment: interactive("comment", api.comment),
    ...(api.updateComment === undefined
      ? {}
      : { updateComment: interactive("updateComment", api.updateComment) }),
    submitReview: interactive("submitReview", api.submitReview),
    listReviewerCandidates: interactive("listReviewerCandidates", api.listReviewerCandidates),
    setReviewerRequest: interactive("setReviewerRequest", api.setReviewerRequest),
    ...(api.listLabelCandidates === undefined
      ? {}
      : { listLabelCandidates: interactive("listLabelCandidates", api.listLabelCandidates) }),
    ...(api.setLabels === undefined ? {} : { setLabels: interactive("setLabels", api.setLabels) }),
    ...(api.listRepositoryLabels === undefined
      ? {}
      : { listRepositoryLabels: interactive("listRepositoryLabels", api.listRepositoryLabels) }),
    ...(api.searchRepositoryAuthors === undefined
      ? {}
      : {
          searchRepositoryAuthors: interactive(
            "searchRepositoryAuthors",
            api.searchRepositoryAuthors,
          ),
        }),
    ...(api.searchRepositoryReferences === undefined
      ? {}
      : {
          searchRepositoryReferences: interactive(
            "searchRepositoryReferences",
            api.searchRepositoryReferences,
          ),
        }),
    replyToThread: interactive("replyToThread", api.replyToThread),
    setReaction: interactive("setReaction", api.setReaction),
    setThreadResolution: interactive("setThreadResolution", api.setThreadResolution),
  };
  // Optional provider methods must be forwarded too; returning the interface alone permits omissions.
  return wrapped satisfies PullRequestProviderApi &
    Record<Exclude<keyof PullRequestProviderApi, keyof typeof wrapped>, never>;
}
