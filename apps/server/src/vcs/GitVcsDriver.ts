import * as NodeBuffer from "node:buffer";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsError,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type WorktreesDirectoryStatus,
  type WorktreeSubmodules,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { checkpointCommitResult, workTreeProbeResult } from "./gitRepositoryProbe.ts";
import {
  makeGitVcsDriverCore,
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import {
  materializeWorkspaceSnapshot,
  type MaterializeWorkspaceSnapshotInput,
} from "./GitWorkspaceSnapshotMaterialize.ts";
import { chunkPathsForGitCheckIgnore } from "./gitCheckIgnoreChunks.ts";
import { parseGitRemoteVerboseOutput } from "./gitRemoteParsing.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number | null;
  /**
   * Fail only after Git prints nothing for this long, instead of after `timeoutMs`.
   * For commands whose healthy duration is unbounded but which report progress.
   */
  readonly stallTimeoutMs?: number;
  readonly forceKillAfterMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  /** With appendTruncationMarker, line callbacks continue beyond the buffer cap for progress-only consumers. */
  readonly keepLineCallbacksAfterTruncation?: boolean;
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  branchChanges?: VcsStatusResult["branchChanges"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitLocalStatusOptions {
  readonly includeDivergence?: boolean;
  readonly includeBranchChanges?: boolean;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeProgress {
  /** Git refuses existing paths; claimed paths belong to this call and can be removed on cancel. */
  readonly onWorktreeClaimed?: (path: string) => Effect.Effect<void, never>;
  /**
   * Fires before checkout when the configured `worktreesDirectory` is
   * unavailable and the worktree goes to the default directory instead.
   */
  readonly onWorktreesDirectoryFallback?: (
    status: WorktreesDirectoryStatus & {
      readonly unavailable: NonNullable<WorktreesDirectoryStatus["unavailable"]>;
    },
  ) => Effect.Effect<void, never>;
  readonly onCheckoutProgress?: (input: {
    percent: number;
    completed: number;
    total: number;
  }) => Effect.Effect<void, never>;
  /** A Git hook, usually post-checkout, started after the files were written. */
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  /**
   * The hook stopped printing long enough to count as stuck. Git runs post-checkout only
   * after the worktree is complete, so the worktree is kept and `createWorktree` succeeds.
   */
  readonly onHookStalled?: (input: {
    readonly hookName: string;
    readonly detail: string;
  }) => Effect.Effect<void, never>;
  /** Directories the project file keeps out of this worktree through sparse checkout. */
  readonly onSparseCheckout?: (excluded: ReadonlyArray<string>) => Effect.Effect<void, never>;
  readonly onSubmodulesStarted?: () => Effect.Effect<void, never>;
  readonly onSubmodulesDisabled?: (input: {
    source: "settings" | "t3.json";
  }) => Effect.Effect<void, never>;
  readonly onSubmoduleLine?: (line: string) => Effect.Effect<void, never>;
  readonly onSubmodulesFinished?: (input: {
    ok: boolean;
    detail: string | null;
  }) => Effect.Effect<void, never>;
  /**
   * Fires when `reuseExistingBranch` picked up a branch that already existed. `reused` means
   * its clean GOAT worktree was bound as is, so the caller must not remove it on failure;
   * `added` means a new worktree was checked out for the existing branch.
   */
  readonly onExistingBranch?: (input: {
    readonly worktree: "reused" | "added";
    readonly fastForwarded: boolean;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeOptions {
  readonly progress?: CreateWorktreeProgress;
  /** Null or omitted defers to the checkout's t3.json. */
  readonly submodules?: WorktreeSubmodules | null;
  readonly worktreesDirectory?: string;
  /**
   * When `newRefName` already exists without commits beyond `refName`, fast-forward and use it
   * (and its clean worktree at the target path) instead of failing. A branch with its own
   * commits or a dirty or foreign checkout still fails, naming the existing_worktree launch.
   */
  readonly reuseExistingBranch?: boolean;
  /**
   * The caller runs the project's worktree setup script itself, so a repository hook that
   * honors `GOAT_WORKTREE_SETUP=0` (this repository's post-checkout does) skips installing
   * dependencies inside `git worktree add` a second time.
   */
  readonly skipSetupHook?: boolean;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
  readonly stage?: { readonly filePaths?: readonly string[] };
}

export interface ExistingBranchState {
  readonly tip: string;
  readonly baseSha: string;
  /** Commits on the branch that its base lacks; any is work a reuse could lose. */
  readonly uniqueCommits: number;
  readonly worktreePath: string | null;
  /** Uncommitted or untracked changes in that worktree. */
  readonly dirty: boolean;
}

export interface GitDeleteLocalBranchInput {
  readonly cwd: string;
  readonly refName: string;
  readonly force?: boolean;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

/** Where `pushCurrentBranch` would send the checked-out branch. */
export interface GitPushTarget {
  remoteName: string;
  branchName: string;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  exactName?: boolean;
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchRefInput {
  cwd: string;
  /** A ref on the primary remote, such as a host's change request head ref. */
  ref: string;
}

export interface GitResolveCommitInput {
  cwd: string;
  revision: string;
}

export interface GitResolveCommitResult {
  commitSha: string;
}

export interface GitRefreshCheckedOutBranchInput {
  cwd: string;
  targetCommit: string;
  /** Pre-fetch upstream commit; resetting away is safe only if HEAD stayed here. */
  resetWhenHeadCommit?: string | null | undefined;
}

export interface GitRefreshCheckedOutBranchResult {
  headCommit: string;
  moved: boolean;
  onTarget: boolean;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitFetchRemoteInput {
  cwd: string;
  remoteName: string;
  refName?: string;
}

export interface GitRemoteExistsInput {
  cwd: string;
  remoteName: string;
}

export interface GitRemoteBranchExistsInput extends GitRemoteExistsInput {
  refName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
  cwd: string;
  refName: string;
  fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
  commitSha: string;
  remoteRefName: string;
}

export interface GitFetchWorktreeBaseCommitInput {
  cwd: string;
  refName: string;
  /** Each line the fetch prints, progress included, for a launch's preparation log. */
  onOutputLine?: ((line: string) => Effect.Effect<void, never>) | undefined;
}

export interface GitWorktreeBaseRemote {
  remoteName: string;
  branchName: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemoteStatusOptions {
  readonly refreshUpstream?: boolean;
}

export class GitWorkspaceSnapshotError extends Schema.TaggedError<GitWorkspaceSnapshotError>()(
  "GitWorkspaceSnapshotError",
  { code: Schema.Literals(["unsupported_snapshot", "head_changed"]) },
) {}
export interface GitWorkspaceSnapshotInput {
  readonly cwd: string;
  readonly snapshotRef: string;
}
export interface GitWorkspaceSnapshotResult {
  readonly snapshotRef: string;
  readonly commitOid: string;
  readonly addedUntrackedPaths: ReadonlyArray<string>;
  /** False when the snapshot omitted contents it could not read. */
  readonly complete: boolean;
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsLocal: (
      cwd: string,
      options?: GitLocalStatusOptions,
    ) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
      options?: { readonly includePatch?: boolean },
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    /** Where `pushCurrentBranch` would push the checked-out branch; null with no remote or when Git picks. */
    readonly resolvePushTarget: (
      cwd: string,
      current: { readonly branch: string; readonly hasUpstream: boolean },
    ) => Effect.Effect<GitPushTarget | null, GitCommandError>;
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    /**
     * The branch, named as on the host, that GOAT recorded `branch` was cut from. Null when none
     * was recorded.
     */
    readonly readBranchBase: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly resolveBranchName: (
      cwd: string,
      refName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    /** Force-updates local `branch` to the primary remote's `ref`. */
    readonly fetchRefIntoBranch: (
      input: GitFetchRefInput & { readonly branch: string },
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRefCommit: (
      input: GitFetchRefInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly resolveCommit: (
      input: GitResolveCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly refreshCheckedOutBranch: (
      input: GitRefreshCheckedOutBranchInput,
    ) => Effect.Effect<GitRefreshCheckedOutBranchResult, GitCommandError>;
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: GitRemoteExistsInput) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (
      input: GitRemoteBranchExistsInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
    readonly resolveWorktreeBaseRemote: (
      input: GitFetchWorktreeBaseCommitInput,
    ) => Effect.Effect<GitWorktreeBaseRemote | null, GitCommandError>;
    /**
     * Fetches the configured upstream, explicit remote ref, or origin; null uses the local base.
     * A caller that already ran `resolveWorktreeBaseRemote` passes its result as `remote`.
     */
    readonly fetchWorktreeBaseCommit: (
      input: GitFetchWorktreeBaseCommitInput & { readonly remote?: GitWorktreeBaseRemote },
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult | null, GitCommandError>;
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly listWorktreePaths: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    /**
     * Absolute path of the worktree that has `branch` checked out, or null when
     * no worktree of the repository at `cwd` has it.
     */
    /** Null when `branch` does not exist; prunes worktree records whose folders are gone. */
    readonly inspectExistingBranch: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly baseRef: string;
    }) => Effect.Effect<ExistingBranchState | null, GitCommandError>;
    readonly branchWorktreePath: (input: {
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<string | null, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  } & import("./GitSharedConfig.ts").SharedConfigDriver
>()("goat/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FLAGGED_INDEX_ENTRIES_MAX_BYTES = 1024 * 1024;
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

const gitCommand = Effect.fn("GitVcsDriver.gitCommand")(
  (
    process: VcsProcess.VcsProcess["Service"],
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
      readonly appendTruncationMarker?: boolean;
    },
  ) =>
    process.run({
      operation,
      command: "git",
      args: ["-C", cwd, ...args],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      ...(options?.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
    }),
);

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
  const hostPlatform = yield* HostProcess.Platform;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const probeWorkTree = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    maxOutputBytes: number,
  ) =>
    workTreeProbeResult(
      cwd,
      fileSystem,
      gitCommand(vcsProcess, operation, cwd, args, {
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes,
      }),
    );
  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    probeWorkTree(
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      4_096,
    ).pipe(Effect.map((stdout) => stdout?.trim() === "true"));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    // One spawn answers all three; outside a work tree it exits non-zero or prints "false".
    const stdout = yield* probeWorkTree(
      "GitVcsDriver.detectRepository",
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"],
      16_384,
    );
    if (stdout === null) return null;
    const lines = stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
    if (lines[0]?.trim() !== "true") return null;
    // A newline inside a path breaks the line framing; ask for each path on its own.
    const rootPath = lines[1];
    const metadataPath = lines[2];
    if (lines.length !== 3 || rootPath === undefined || metadataPath === undefined) {
      const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository", cwd, [
        "rev-parse",
        "--show-toplevel",
      ]);
      const gitCommonDir = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository", cwd, [
        "rev-parse",
        "--git-common-dir",
      ]).pipe(Effect.orElseSucceed(() => null));
      return {
        kind: "git" as const,
        rootPath: root.stdout.trim(),
        metadataPath: gitCommonDir?.stdout.trim() || null,
        freshness: yield* nowFreshness(),
      };
    }

    return {
      kind: "git" as const,
      rootPath: rootPath.trim(),
      metadataPath: metadataPath.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedGitStdoutPaths(result),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string, env?: NodeJS.ProcessEnv) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
      ...(env !== undefined ? { env } : {}),
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      env: { LC_ALL: "C" },
      allowNonZeroExit: true,
    }).pipe(Effect.flatMap((result) => checkpointCommitResult(cwd, result)));

  // Git reports relative paths from the physical cwd, which can differ from a symlink.
  const resolveGitCommonDir = Effect.fn("GitVcsDriver.resolveGitCommonDir")(function* (
    cwd: string,
  ) {
    const result = yield* execute({
      operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
      cwd,
      args: ["rev-parse", "--git-common-dir"],
    });
    const gitCommonDir = result.stdout.trim();
    if (path.isAbsolute(gitCommonDir)) return gitCommonDir;
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    return path.resolve(physicalCwd, gitCommonDir);
  });

  // Git defaults and macOS writeout-only can leave empty refs after crashes; flush before publication.
  // Set fsync first: Git 2.36 ignores unknown batch without resetting the method.
  // Batch fully flushes refs and equals fsync on macOS HFS+/APFS and Windows NTFS/ReFS.
  // Keep per-object fsync elsewhere; VcsProcess retries unsupported macOS full flushes with plain fsync.
  const durableWrite = [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
    ...(hostPlatform === "darwin" || hostPlatform === "win32"
      ? ["-c", "core.fsyncMethod=batch"]
      : []),
  ] as const;

  // Checkpoints must handle existing paths beyond Windows MAX_PATH, even when
  // core.longpaths is disabled in the user's Git configuration.
  const longPaths = hostPlatform === "win32" ? ["-c", "core.longpaths=true"] : [];

  const captureTree = Effect.fn("GitVcsDriver.captureTree")(function* (input: {
    readonly cwd: string;
    readonly ref: string;
    readonly strict: boolean;
  }): Effect.fn.Return<GitWorkspaceSnapshotResult, VcsError | GitWorkspaceSnapshotError> {
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    const readUntracked = Effect.fn("GitVcsDriver.snapshot.readUntracked")(function* () {
      const paths = yield* execute({
        operation,
        cwd: input.cwd,
        args: [...longPaths, "ls-files", "--others", "--exclude-standard", "-z", "--", "."],
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      });
      if (paths.stdoutTruncated)
        return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
      return splitNullSeparatedGitStdoutPaths(paths);
    });
    // Scratch index writes must not expire the real index's sharedindex files.
    const indexConfig = [
      ...longPaths,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "sparse.expectFilesOutsideOfPatterns=false",
      "-c",
      "core.splitIndex=false",
      "-c",
      "splitIndex.sharedIndexExpire=never",
    ];
    const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
    const indexId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const tempIndexPath = path.join(gitCommonDir, `goat-checkpoint-index-${indexId}`);
    const commitEnv: NodeJS.ProcessEnv = {
      GIT_INDEX_FILE: tempIndexPath,
      GIT_AUTHOR_NAME: "GOAT",
      GIT_AUTHOR_EMAIL: "checkpoint@goat.invalid",
      GIT_COMMITTER_NAME: "GOAT",
      GIT_COMMITTER_EMAIL: "checkpoint@goat.invalid",
    };

    // Forced process termination can leave Git's private index lock behind.
    const cleanupTempIndex = Effect.forEach(
      [tempIndexPath, `${tempIndexPath}.lock`],
      (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );

    return yield* Effect.gen(function* () {
      const capturedHead = yield* resolveHeadCommit(input.cwd);
      const headExists = capturedHead !== null;
      const untrackedBefore = input.strict ? yield* readUntracked() : [];
      if (input.strict) {
        if (!headExists)
          return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
        const conflicts = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["ls-files", "-u", "-z"],
        });
        const entries = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["ls-files", "--stage", "-z"],
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        });
        if (
          conflicts.stdoutTruncated ||
          conflicts.stdout.length > 0 ||
          entries.stdoutTruncated ||
          /(?:^|\0)160000 /u.test(entries.stdout)
        )
          return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
        for (const entry of untrackedBefore.filter((name) => name.endsWith("/"))) {
          const embedded = yield* fileSystem
            .exists(path.join(input.cwd, entry, ".git"))
            .pipe(
              Effect.mapError(
                () => new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" }),
              ),
            );
          if (embedded)
            return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
        }
      }
      const sparseConfig = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["config", "--bool", "core.sparseCheckout"],
        allowNonZeroExit: true,
      });
      let sparseCheckout = sparseConfig.stdout.trim() === "true";
      if (sparseCheckout) {
        const help = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-h"],
          allowNonZeroExit: true,
        });
        sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
      }
      if (headExists) {
        const reusedIndex = yield* Effect.gen(function* () {
          const indexPath = yield* execute({
            operation,
            cwd: input.cwd,
            args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
          });
          const { mtime } = yield* fileSystem.stat(indexPath.stdout.trim());
          if (Option.isNone(mtime)) return false;
          // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
          const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
          if (indexTime <= 0) return false;
          yield* fileSystem.copyFile(indexPath.stdout.trim(), tempIndexPath);
          // Retain stat data only where the copied index already matches HEAD.
          yield* execute({
            operation,
            cwd: input.cwd,
            args: [...indexConfig, "read-tree", "--reset", capturedHead!],
            env: commitEnv,
          });
          // read-tree can rewrite the index, so restore its racy timestamp afterward.
          yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
          let fallback = false;
          let flaggedBytes = 0;
          let skippedBytes = 0;
          let recordStart = true;
          let collect: "flagged" | "skipped" | undefined;
          let record: Uint8Array[] = [];
          const flagged: string[] = [];
          const skipped: string[] = [];
          yield* vcsProcess.run({
            operation,
            command: "git",
            cwd: input.cwd,
            args: [...indexConfig, "ls-files", "--full-name", "--sparse", "--stage", "-v", "-z"],
            env: commitEnv,
            maxOutputBytes: 4_096,
            outputMode: "truncate",
            // Only tags and flagged or skip-worktree records matter; scan NUL-delimited records.
            onStdoutChunk: (chunk) => {
              let start = 0;
              while (start < chunk.length && !fallback) {
                const end = chunk.indexOf(0, start);
                if (recordStart) {
                  const tag = chunk[start] ?? -1;
                  record = [];
                  // Sparse skip-worktree bits are expected; only in-cone ones are manual.
                  collect =
                    tag === 83 && sparseCheckout
                      ? "skipped"
                      : (tag >= 97 && tag <= 122) || tag === 83
                        ? "flagged"
                        : undefined;
                  // index-info cannot keep skip-worktree while dropping assume-unchanged.
                  if (tag === 115 && sparseCheckout) fallback = true;
                }
                if (collect !== undefined && !fallback) {
                  const piece = chunk.subarray(start, end === -1 ? undefined : end);
                  record.push(Buffer.from(piece));
                  if (collect === "flagged") {
                    if ((flaggedBytes += piece.length) > FLAGGED_INDEX_ENTRIES_MAX_BYTES)
                      fallback = true;
                  } else if ((skippedBytes += piece.length) > WORKSPACE_FILES_MAX_OUTPUT_BYTES) {
                    fallback = true;
                  }
                  if (end !== -1 && !fallback) {
                    const full = Buffer.concat(record);
                    record = [];
                    // Sparse directory entries stay collapsed.
                    if (collect === "flagged" || full.at(-1) !== 47) {
                      // Drop the "<tag> " prefix, leaving index-info's "<mode> <oid> <stage>\t<path>".
                      const entry = full.subarray(2);
                      if (!NodeBuffer.isUtf8(entry)) fallback = true;
                      else (collect === "flagged" ? flagged : skipped).push(entry.toString("utf8"));
                    }
                  }
                }
                recordStart = end !== -1;
                if (!recordStart) break;
                start = end + 1;
              }
            },
          });
          if (fallback) return false;
          if (skipped.length > 0) {
            const paths = skipped.map((entry) => entry.slice(entry.indexOf("\t") + 1));
            const stdin = paths.join("\0") + "\0";
            // check-rules echoes a subset of its input, so the input size bounds its output.
            const rules = yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
              stdin,
              env: commitEnv,
              maxOutputBytes: Buffer.byteLength(stdin),
              outputMode: "error",
            });
            const selected = new Set(rules.stdout.split("\0"));
            for (const entry of skipped) {
              if (selected.has(entry.slice(entry.indexOf("\t") + 1))) {
                flaggedBytes += Buffer.byteLength(entry) + 1;
                if (flaggedBytes > FLAGGED_INDEX_ENTRIES_MAX_BYTES) return false;
                flagged.push(entry);
              }
            }
          }
          if (flagged.length > 0) {
            // Flagged gitlinks keep the fresh-index behaviour rather than a guessed one.
            if (flagged.some((entry) => entry.startsWith("160000 "))) return false;
            yield* execute({
              operation,
              cwd: input.cwd,
              // core.ignorestat would mark these assume-unchanged, hiding edits from add -A.
              args: [
                ...indexConfig,
                "-c",
                "core.ignorestat=false",
                "update-index",
                "-z",
                "--index-info",
              ],
              stdin: flagged.join("\0") + "\0",
              env: commitEnv,
            });
            yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
          }
          return true;
        }).pipe(Effect.orElseSucceed(() => false));
        if (!reusedIndex) {
          if (sparseCheckout) {
            const cone = yield* execute({
              operation,
              cwd: input.cwd,
              args: ["config", "--bool", "core.sparseCheckoutCone"],
              allowNonZeroExit: true,
            });
            // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
            if (cone.stdout.trim() !== "true") {
              return yield* new VcsProcessExitError({
                operation,
                command: "git read-tree",
                cwd: input.cwd,
                exitCode: 1,
                detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
              });
            }
          }
          yield* cleanupTempIndex;
          yield* execute({
            operation,
            cwd: input.cwd,
            // A fresh sparse index represents excluded directories without marking them deleted.
            args: sparseCheckout
              ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", capturedHead!]
              : [...indexConfig, "read-tree", capturedHead!],
            env: commitEnv,
          });
        }
      }

      const prefix = (yield* execute({
        operation,
        cwd: input.cwd,
        args: ["rev-parse", "--show-prefix"],
      })).stdout.replace(/\n$/, "");
      const workspaceIgnored =
        prefix !== "" &&
        (yield* filterIgnoredPaths(input.cwd, [`../${prefix.slice(0, -1).split("/").at(-1)}`]))
          .length === 0;
      if (workspaceIgnored && !input.strict) {
        // HEAD omits staged-only paths. Seed just this workspace's additions, keeping
        // unrelated staged changes and the scratch index's sparse flags untouched.
        const additions = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            "-c",
            "core.quotePath=true",
            "diff",
            "--cached",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            "--no-relative",
            "--ignore-submodules=none",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--ita-visible-in-index",
            "--diff-filter=A",
            "--",
            ".",
          ],
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          outputMode: "error",
        });
        if (additions.stdout.length > 0) {
          // Git's quoted paths round-trip through index-info, including non-UTF-8 names.
          yield* execute({
            operation,
            cwd: input.cwd,
            args: [...indexConfig, "-c", "index.sparse=false", "update-index", "--index-info"],
            stdin: additions.stdout.replace(/^:000000 ([0-7]{6}) 0+ ([0-9a-f]+) A\t/gm, "$1 $2\t"),
            env: commitEnv,
          });
        }
        const tracked = yield* execute({
          operation,
          cwd: input.cwd,
          args: [...indexConfig, "ls-files", "--cached", "-z", "--", "."],
          env: commitEnv,
          maxOutputBytes: 1,
          outputMode: "truncate",
        });
        if (tracked.stdout.length === 0) {
          return yield* new VcsUnsupportedOperationError({
            operation,
            kind: "git",
            detail: "The workspace directory is ignored by its Git repository.",
          });
        }
      }

      const stageConfig = ["-c", "core.safecrlf=false"];
      let omittedContents = capturedHead === null;
      if (input.strict || capturedHead !== null) {
        // Newly staged paths belong to the snapshot even when ignore rules match them.
        // Read the real index, then stage disk content only into the private index.
        const staged = yield* Effect.gen(function* () {
          const additions = yield* execute({
            operation,
            cwd: input.cwd,
            args: [
              "diff",
              "--cached",
              "--no-renames",
              "--name-only",
              ...(input.strict ? [] : ["--relative"]),
              "--diff-filter=A",
              "-z",
              capturedHead!,
              "--",
              ...(input.strict ? [] : ["."]),
            ],
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          });
          const deletions = yield* execute({
            operation,
            cwd: input.cwd,
            args: ["ls-files", "--deleted", "-z"],
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          });
          return { additions, deletions };
        }).pipe(Effect.result);
        if (
          staged._tag === "Failure" ||
          staged.success.additions.stdoutTruncated ||
          staged.success.deletions.stdoutTruncated
        ) {
          if (input.strict) {
            if (staged._tag === "Failure") return yield* staged.failure;
            return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
          }
          omittedContents = true;
        } else {
          const { additions, deletions } = staged.success;
          // Git's deletion scan retains dangling symlinks, unlike a filesystem stat.
          const deletedPaths = new Set(splitNullSeparatedGitStdoutPaths(deletions));
          const presentPaths = splitNullSeparatedGitStdoutPaths(additions).filter(
            (name) => !deletedPaths.has(name),
          );
          if (presentPaths.length > 0) {
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [
                "--literal-pathspecs",
                ...indexConfig,
                ...durableWrite,
                ...stageConfig,
                "add",
                ...(sparseCheckout ? ["--sparse"] : []),
                "-f",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
              ],
              stdin: presentPaths.join("\0") + "\0",
              env: commitEnv,
            });
          }
        }
      }

      const stageFiles = (exclusions: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd: input.cwd,
          // Preserve absent skipped entries, but capture present nonignored files outside the cone.
          args: [
            ...indexConfig,
            ...durableWrite,
            ...stageConfig,
            "add",
            ...(sparseCheckout ? ["--sparse"] : []),
            workspaceIgnored ? "-u" : "-A",
            "--",
            ".",
            ...exclusions,
          ],
          env: commitEnv,
        });
      yield* input.strict
        ? stageFiles([])
        : stageFiles([]).pipe(
            Effect.catchTags({
              VcsProcessExitError: (error) =>
                Effect.gen(function* () {
                  // Git cannot stage an embedded repository until it has a commit. Discover these
                  // only after staging fails so ordinary checkpoints do not need another file scan.
                  const untracked = yield* execute({
                    operation,
                    cwd: input.cwd,
                    args: [
                      ...longPaths,
                      "ls-files",
                      "--others",
                      "--exclude-standard",
                      "-z",
                      "--",
                      ".",
                    ],
                    env: commitEnv,
                    maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                  });
                  if (untracked.stdoutTruncated) return yield* error;
                  const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                    entry.endsWith("/"),
                  );
                  // Refuse excessive recovery work before probing any nested repositories.
                  if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
                  // Discover each child's repository instead of inheriting the server's Git bindings.
                  const nestedRepoEnv: NodeJS.ProcessEnv = {
                    ...process.env,
                    GIT_DIR: undefined,
                    GIT_WORK_TREE: undefined,
                    GIT_COMMON_DIR: undefined,
                    GIT_INDEX_FILE: undefined,
                    GIT_OBJECT_DIRECTORY: undefined,
                    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                  };
                  const exclusions: Array<string> = [];
                  for (const entry of candidates) {
                    const nestedCwd = path.join(input.cwd, entry);
                    if (
                      (yield* fileSystem
                        .exists(path.join(nestedCwd, ".git"))
                        .pipe(Effect.mapError(() => error))) &&
                      !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                    ) {
                      exclusions.push(`:(exclude,literal)${entry}`);
                    }
                  }
                  if (exclusions.length === 0) return yield* error;
                  omittedContents = true;
                  return yield* stageFiles(exclusions);
                }).pipe(
                  // One budget covers discovery, queued Git admission, probes, and the staging retry.
                  Effect.timeoutOrElse({
                    duration: CHECKPOINT_RECOVERY_TIMEOUT,
                    orElse: () => Effect.fail(error),
                  }),
                ),
            }),
          );

      const writeTreeResult = yield* execute({
        operation,
        cwd: input.cwd,
        args: [...indexConfig, ...durableWrite, "write-tree"],
        env: commitEnv,
      });
      const treeOid = writeTreeResult.stdout.trim();
      if (treeOid.length === 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git write-tree",
          cwd: input.cwd,
          exitCode: 0,
          detail: "git write-tree returned an empty tree oid.",
        });
      }

      // A gitlink preserves only the nested HEAD, never its dirty contents or objects.
      // Seal completeness at production time; an exporter cannot reconstruct omitted paths
      // by inspecting the immutable tree, nor safely substitute the later live workspace.
      const treeEntries = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["ls-tree", "-r", "-z", treeOid],
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      });
      const complete =
        !omittedContents &&
        !treeEntries.stdoutTruncated &&
        !/(?:^|\0)160000 /u.test(treeEntries.stdout);
      const message = input.strict
        ? `goat snapshot ref=${input.ref}`
        : `goat checkpoint ref=${input.ref}`;
      // HEAD is the parent so listAuthoredPaths can see how HEAD moved between checkpoints.
      const commitTreeResult = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          ...durableWrite,
          "commit-tree",
          treeOid,
          ...(capturedHead === null ? [] : ["-p", capturedHead]),
          "-m",
          message,
        ],
        env: commitEnv,
      });
      const commitOid = commitTreeResult.stdout.trim();
      if (commitOid.length === 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git commit-tree",
          cwd: input.cwd,
          exitCode: 0,
          detail: "git commit-tree returned an empty commit oid.",
        });
      }

      if (input.strict && (yield* resolveHeadCommit(input.cwd)) !== capturedHead)
        return yield* new GitWorkspaceSnapshotError({ code: "head_changed" });
      const untrackedAfter = input.strict ? yield* readUntracked() : [];
      const treePaths = input.strict
        ? yield* execute({
            operation,
            cwd: input.cwd,
            args: ["ls-tree", "-r", "--name-only", "-z", treeOid],
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          })
        : undefined;
      if (treePaths?.stdoutTruncated)
        return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
      const capturedPaths = new Set(
        treePaths === undefined ? [] : splitNullSeparatedGitStdoutPaths(treePaths),
      );
      const addedUntrackedPaths = [...new Set([...untrackedBefore, ...untrackedAfter])].filter(
        (name) => capturedPaths.has(name),
      );
      if (input.strict) {
        // Hold HEAD's ref lock through publication so the captured parent stays current.
        const published = yield* execute({
          operation,
          cwd: input.cwd,
          args: [...durableWrite, "update-ref", "--stdin"],
          stdin: `start\nverify HEAD ${capturedHead}\ncreate ${input.ref} ${commitOid}\nprepare\ncommit\n`,
          allowNonZeroExit: true,
        });
        if (published.exitCode !== 0) {
          if (
            /cannot lock ref 'HEAD':.*(?:but expected|unable to resolve reference)/u.test(
              published.stderr,
            )
          )
            return yield* new GitWorkspaceSnapshotError({ code: "head_changed" });
          return yield* new VcsProcessExitError({
            operation,
            command: "git update-ref",
            cwd: input.cwd,
            exitCode: published.exitCode,
            detail: "Snapshot ref transaction failed.",
          });
        }
      } else {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [...durableWrite, "update-ref", input.ref, commitOid],
        });
      }
      return { snapshotRef: input.ref, commitOid, addedUntrackedPaths, complete };
    }).pipe(Effect.ensuring(cleanupTempIndex));
  });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: (input) =>
      captureTree({
        cwd: input.cwd,
        ref: input.checkpointRef,
        strict: false,
      }).pipe(
        Effect.map(({ commitOid, complete }) => ({ commitOid, complete })),
        Effect.mapError((error) =>
          error._tag === "GitWorkspaceSnapshotError"
            ? new VcsProcessExitError({
                operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
                command: "git",
                cwd: input.cwd,
                exitCode: 1,
                detail: "Checkpoint snapshot capture was refused.",
              })
            : error,
        ),
      ),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      const tracked = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["ls-files", "--cached", `--with-tree=${commitOid}`, "-z", "--", "."],
      });
      // An empty index and checkpoint have nothing for git restore's pathspec to match.
      if (tracked.stdout.length > 0) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...longPaths,
            "restore",
            "--source",
            commitOid,
            "--worktree",
            "--staged",
            "--",
            ".",
          ],
        });
      }
      // Restoring away the last tracked file can remove a nested workspace directory.
      const recreateWorkspace = fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "git restore",
              cwd: input.cwd,
              exitCode: 0,
              detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
            }),
        ),
      );
      yield* recreateWorkspace;
      const cleaned = yield* execute({
        operation,
        cwd: input.cwd,
        args: [...longPaths, "clean", "-fd", "--", "."],
        allowNonZeroExit: true,
      });
      if (cleaned.exitCode !== 0) {
        // Git can remove every child, then fail trying to remove './' itself.
        const emptiedWorkspace =
          cleaned.exitCode === 1 &&
          /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
          (yield* fileSystem.readDirectory(input.cwd).pipe(
            Effect.map((entries) => entries.length === 0),
            Effect.orElseSucceed(() => false),
          ));
        if (!emptiedWorkspace)
          return yield* new VcsProcessExitError({
            operation,
            command: "git clean",
            cwd: input.cwd,
            exitCode: cleaned.exitCode,
            detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
          });
      }
      // On Windows the same clean can remove './' and exit 0.
      yield* recreateWorkspace;

      yield* execute({
        operation,
        cwd: input.cwd,
        args: [...longPaths, "reset", "--quiet", "--", "."],
      });

      return true;
    }),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      if (input.filePaths?.length === 0) return "";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          // Not --no-relative, which Git before 2.28 rejects.
          "-c",
          "diff.relative=false",
          "-c",
          "diff.suppressBlankEmpty=false",
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--submodule=short",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
          // Paths are repository-relative, while cwd can be a subdirectory.
          ...(input.filePaths
            ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
            : []),
        ],
        allowNonZeroExit: true,
        maxOutputBytes: input.maxOutputBytes ?? VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return result.stdout;
    }),

    listAuthoredPaths: Effect.fn("GitVcsDriver.checkpoints.listAuthoredPaths")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.listAuthoredPaths";
      const heads = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "log",
          "--no-walk=unsorted",
          "--format=%P %ct",
          `${input.fromCheckpointRef}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
      });
      const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
      const [startHead = "", capturedAt = ""] = fromLine.split(" ");
      const [endHead = ""] = toLine.split(" ");
      if (startHead === "" || endHead === "" || startHead === endHead) {
        return null;
      }

      const listPaths = (args: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd: input.cwd,
          args: [
            "-c",
            "diff.relative=false",
            // log.showSignature prints verification text into the path list.
            "-c",
            "log.showSignature=false",
            ...args,
            "--name-only",
            "-z",
            "--no-renames",
            "--no-ext-diff",
          ],
          maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: "error",
        }).pipe(Effect.map((result) => result.stdout.split("\0")));
      // Remerge diffs retain merge conflict fixes while excluding clean upstream changes.
      const pathLists = yield* Effect.all(
        [
          listPaths(["diff", startHead, `${input.fromCheckpointRef}^{commit}`]),
          listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
          listPaths(["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
          listPaths([
            "log",
            "--format=",
            "--diff-merges=remerge",
            `--since=@${capturedAt}`,
            `${startHead}..${endHead}`,
          ]),
        ],
        { concurrency: "unbounded" },
      );
      return new Set(pathLists.flat().filter((path) => path.length > 0));
    }),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
      },
    ),
  };

  return {
    capabilities,
    execute,
    captureWorkspaceSnapshot: (input: GitWorkspaceSnapshotInput) =>
      captureTree({ cwd: input.cwd, ref: input.snapshotRef, strict: true }),
    materializeWorkspaceSnapshot: (input: MaterializeWorkspaceSnapshotInput) =>
      materializeWorkspaceSnapshot({ execute, fileSystem, path }, input),
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const layerVcs = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
