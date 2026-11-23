import { SourceControlProviderKind } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type { BackgroundScope, VcsStatusLocalResult, VcsStatusRemoteResult } from "@goat/contracts";
import { GitManagerError } from "@goat/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import { VcsRefSnapshot } from "./VcsRefSnapshot.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

export const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

export const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

export const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    url: "https://github.com/goat-si/goat/pull/2978",
    baseRef: "main",
    headRef: "upstream-topic",
    state: "open",
  },
};

export function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  refSnapshot?: string | null;
  currentDivergence?: Pick<VcsStatusRemoteResult, "aheadCount" | "behindCount">;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  remoteStatusReusedDetails?: Array<boolean>;
  localStatusBranchChanges?: Array<boolean>;
  remoteStatusError?: GitManagerError;
  backgroundWorkEnabled?: boolean;
  automaticFetchInterval?: Effect.Effect<Duration.Duration>;
  beforeRemoteStatus?: Effect.Effect<void, GitManagerError>;
  onRemoteStatusComplete?: (cwd: string) => Effect.Effect<void>;
  beforeLocalStatus?: Effect.Effect<void>;
  branchRead?: () => Effect.Effect<string | null>;
  headPath?: string;
  headPathCalls?: number;
  failLocalStatus?: boolean;
  onLocalStatusFailure?: Effect.Effect<void>;
  beforeInvalidate?: Effect.Effect<void>;
  refSnapshot?: string | null;
  fileSystem?: FileSystem.FileSystem;
  pullCurrentBranch?: GitWorkflowService.GitWorkflowService["Service"]["pullCurrentBranch"];
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provide(
      Layer.succeed(VcsRefSnapshot, () => Effect.sync(() => state.refSnapshot ?? null)),
    ),
    Layer.provideMerge(
      state.fileSystem
        ? Layer.merge(Layer.succeed(FileSystem.FileSystem, state.fileSystem), Path.layer)
        : Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
    ),
    Layer.provide(layerBackgroundPolicy(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.succeed(
        VcsStatusBroadcaster.VcsAutomaticFetchInterval,
        state.automaticFetchInterval ?? Effect.succeed(Duration.seconds(30)),
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        repositoryRoot: (cwd) => Effect.succeed(state.currentLocalStatus.isRepo ? cwd : null),
        headPath: () =>
          Effect.sync(() => {
            state.headPathCalls = (state.headPathCalls ?? 0) + 1;
            return state.headPath ?? null;
          }),
        localStatus: (_input, options) =>
          Effect.suspend(() => {
            state.localStatusCalls += 1;
            const includeBranchChanges = options?.includeBranchChanges !== false;
            state.localStatusBranchChanges?.push(includeBranchChanges);
            const { branchChanges: _branchChanges, ...withoutBranchChanges } =
              state.currentLocalStatus;
            if (state.failLocalStatus) {
              return (state.onLocalStatusFailure ?? Effect.void).pipe(
                Effect.andThen(
                  Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "index.lock is held",
                    }),
                  ),
                ),
              );
            }
            return (state.beforeLocalStatus ?? Effect.void).pipe(
              Effect.as(includeBranchChanges ? state.currentLocalStatus : withoutBranchChanges),
            );
          }),
        currentBranch: () =>
          Effect.suspend(
            () => state.branchRead?.() ?? Effect.succeed(state.currentLocalStatus.refName),
          ),
        upstreamDivergence: () =>
          Effect.sync(() => {
            const branch = state.currentLocalStatus.refName;
            if (!state.currentRemoteStatus?.hasUpstream || branch === null) return null;
            const { aheadCount, behindCount } =
              state.currentDivergence ?? state.currentRemoteStatus;
            return {
              refName: branch,
              aheadCount,
              behindCount,
              details: {
                isRepo: true,
                hasPrimaryRemote: true,
                defaultBranch: "main",
                isDefaultBranch: false,
                branch,
                upstreamRef: `origin/${branch}`,
                hasUpstream: true,
                aheadCount,
                behindCount,
                aheadOfDefaultCount: aheadCount,
              },
            };
          }),
        remoteStatus: (input, options) =>
          Effect.suspend(() => {
            return (state.beforeRemoteStatus ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  state.remoteStatusCalls += 1;
                  state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                  state.remoteStatusReusedDetails?.push(options?.statusDetails !== undefined);
                  return state.currentRemoteStatus;
                }),
              ),
              Effect.tap(() => state.onRemoteStatusComplete?.(input.cwd) ?? Effect.void),
              Effect.tap(() =>
                state.remoteStatusError ? Effect.fail(state.remoteStatusError) : Effect.void,
              ),
            );
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }).pipe(Effect.andThen(Effect.suspend(() => state.beforeInvalidate ?? Effect.void))),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
        ...(state.pullCurrentBranch ? { pullCurrentBranch: state.pullCurrentBranch } : {}),
      }),
    ),
  );
}

export function layerBackgroundPolicy(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: false,
      updatedAt: TEST_EPOCH,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(true),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
}
