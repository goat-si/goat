# 020 wp2 / PR2: SSH workspace service

## Stale check at wp2 P (origin/dev f2b8eb7e0, merged into PR1 as fa51b5784)

These amendments override the excerpts below where they disagree. Line anchors below are historical
(written against ba65eae6b); re-locate them by content. Verifier results recorded below are a historical
baseline, not evidence for the current tree.

1. Keep `SshLaunchInput.allowBroadWorkspaceRoot` (SshRemoteDispatch.ts, after `interactionMode`); the SSH MCP
   handler passes it (apps/server/src/mcp/toolkits/ssh/handlers.ts). The managed `$HOME/.goat/repos/<name>`
   passes `broadWorkspaceRoot`, so the workspace launch omits the flag.
2. When `launchThread` gains full-target resolution, keep the broad-root guard that runs right after the
   browse of the target folder.
3. The remote thread launch response now carries `runId?: string | null` and `SshLaunchResult.runId` exists
   (the SSH MCP handler registers a launch watch from it). Any decoder added for the thread response keeps
   `runId`; `SshWorkspaceLaunchResult` may expose it as `remoteRunId` but must not drop it from dispatch.
4. `McpHttpServer.layer` provides LaunchWatchService → SshRemoteDispatch → transport. Move only the
   dispatcher provision out to the server route composition; keep `Layer.provide(LaunchWatchService.layer)`
   inside MCP (it consumes the dispatcher), and keep `ConnectionCatalogBroker.layer` in server.ts and the
   connection-catalog handlers in ws.ts `layerWsRpc`.
5. MCP rejects undeclared top-level tool arguments; `scripts` is declared in the project-create schema, and
   `allowBroadWorkspaceRoot` is never sent to the remote.
6. New RPC literals `connectionCatalog.serve` / `connectionCatalog.respond` exist; `sshWorkspace.launch` /
   `sshWorkspace.fetchBack` do not collide.

Depends on: [000_plan.md](000_plan.md), [010_phase1_local_default.md](010_phase1_local_default.md).
Implementation branch: `goat/ws-picker-2-ssh-service`; PR base: `goat/ws-picker-1-local-default`.
Source anchors were read in the shared coordinator checkout on 2026-10-12; re-anchor after PR1 lands.
This document is executable implementation design, not evidence that the proposed code exists.

The local server will capture the source project's current disk state without changing its checkout,
push a snapshot ref to a managed repository on the selected saved SSH target, and ask that remote
T3 to create and own a worktree thread. Fetch-back finds the matching local project and fetches a
committed remote branch into a dedicated tracking ref. PR3 and PR4 consume guarded commands from
`@t3tools/client-runtime/state/vcs`.

Loop shape: satisfy the authoritative wp2 specification. Trigger: bounded documentation delegation.
Goal: a complete PR2 implementation recipe. Non-goals: executing implementation, FSM/goal ownership,
agent dispatch, branch operations, servers, browser verification, receipts, gateways, automatic retries.
Verifier: current-tree focused tests, three package typechecks, and file-targeted lint below; future
implementation must pass the expanded commands. Stop: write this document and return evidence.
Artifact: this file. Terminal outcomes: design complete with disclosed baseline failures/conflicts,
or missing evidence identified. Escalation: parent resolves Plan conflicts; this worker changes no decisions.

## Scope and invariant decisions

IN: contracts, two RPCs, source-environment authorization, snapshot extraction, managed remote init,
local Git push/readback/fetch, full-target dispatch, scripts passthrough, service/layers/handlers,
shared client commands, and focused behavior tests. OUT: picker/draft/promotion UI (PR3), fetch action
and user docs (PR4), previous-worktree/default changes (PR1), operation storage, `readOperation`,
`connect`, browser SSH gateway, password auth, attachment transfer, content scanning, merges/checkouts,
changing remote T3 worktree placement, remote setup implementation, and automatic relaunch.

Apply D-u4..D-u7, A5..A10 and A13/A14 as amended, and M3..M5 exactly:

- `launch`: `source-control:write` **and** `orchestration:operate`.
- `fetchBack`: `source-control:write` only. Do not add filesystem scopes.
- Repo name is basename slug plus 8 hex SHA-256 of the **stored local workspaceRoot string**;
  repo parent is remote `$HOME/.goat/repos`. Do not hash a project ID, worktree, remote path, or realpath.
- Before snapshot or remote work, require realpath(project.workspaceRoot) to equal realpath of
  `git rev-parse --show-toplevel`. A subdirectory project fails validate/project_not_repo_root;
  tell the user to add the repository root as the project. Realpath is validation only, not naming input.
- Server generates 8 hex opId; local ref `refs/goat/snapshots/<opId>`, pushed branch ref
  `refs/heads/goat/ssh-base/<opId>`, thread branch `goat/ssh/<opId>`.
- Non-bare repo remains unborn. No root checkout, anchor branch, or reset. Publish snapshot refs
  create-only with `--force-with-lease=<ref>:`; the empty expected value prevents replacing any existing ref.
- M4 checks snapshot-added untracked names only. It is an **early warning** with no override field;
  committed secrets and newly staged secrets already tracked in the real index both bypass it.
- Fetch writes `refs/remotes/goat-ssh/<alias>/<branch>` and returns that ref and its OID.
- `beforeLaunch = Effect.void`; `callerRuntimeMode = "full-access"` for this guarded user RPC.
  The local server requires source-control:write plus orchestration:operate, the same authority that
  launches full-access local threads. That authority supplies the remote session ceiling needed for
  first project registration; the thread's `runtimeMode = input.runtimeMode` remains the user's choice.
  Existing thread-originated MCP delegation retains its own caller ceiling and authorization callback.
- Savedness is verified in PR3 against the client catalog; connectionId is correlation, not server
  authority. The server validates the entire target and authorizes the RPC, then uses its own SSH keys.
- Four-PR stack and child-first landing remain M6; this doc authorizes no git operation.

Input provenance: `AGENTS.md`, `000_plan.md`, `/tmp/ssh-wt/E1-web.md`, and architect proposal
`/tmp/ssh-wt/01a12bef-12af-7953-b80e-586c1e221b17.md` were read. The specified server explorer map
`/tmp/ssh-wt/01a12bef-11a5-7f71-8bb1-debbb865eb09.md` is absent; the server anchors below were
verified directly. Codex/Aside/wiki targeted memory searches found no relevant SSH-worktree entries.
The architect's rejected A11/A12 and amended A6/A7/A9/A13 are not implementation requirements.

## File change map

Paths are relative to `/Users/jun/.goat/worktrees/goat/t3-8cf0da21`. No DELETE operations.

| Operation | Exact path                                                     | Change                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEW       | `packages/contracts/src/sshWorkspace.ts`                       | Launch/fetch inputs, outputs, safe tagged stage/code error                                                                                                                                             |
| MODIFY    | `packages/contracts/src/index.ts`                              | Export schemas/types                                                                                                                                                                                   |
| MODIFY    | `packages/contracts/src/rpc.ts`                                | Method literals, Rpc.make entries, WsRpcGroup members                                                                                                                                                  |
| MODIFY    | `packages/contracts/src/clientRpcPermissions.ts`               | Primary scopes and unconditional launch multi-scope rule                                                                                                                                               |
| NEW       | `packages/contracts/src/sshWorkspace.test.ts`                  | Schema JSON round trips and payload boundaries                                                                                                                                                         |
| MODIFY    | `packages/contracts/src/rpc.test.ts`                           | Exact two RPCs and authorization middleware coverage                                                                                                                                                   |
| NEW       | `apps/server/src/sshRemote/SshWorkspaceSync.ts`                | Domain workflow, naming, target validation, init script, transfer/fetch                                                                                                                                |
| NEW       | `apps/server/src/sshRemote/SshWorkspaceSync.test.ts`           | Temp-repo/fake-SSH service behavior and all error activations                                                                                                                                          |
| MODIFY    | `apps/server/src/sshRemote/SshRemoteDispatch.ts`               | Full-target launch; safe remote script/preflight service methods; scripts; full cache key                                                                                                              |
| MODIFY    | `apps/server/src/sshRemote/SshRemoteDispatch.test.ts`          | Full-target compatibility, scripts, identity, cache separation, uncertainty                                                                                                                            |
| MODIFY    | `apps/server/src/vcs/GitVcsDriver.ts`                          | Extract checkpoint capture core; expose strict Git workspace snapshot                                                                                                                                  |
| MODIFY    | `apps/server/src/vcs/GitVcsDriver.test.ts`                     | Capture preservation and strict-mode behavior using existing fixtures                                                                                                                                  |
| MODIFY    | `apps/server/src/vcs/GitVcsDriverCore.test.ts`                 | Git SSH builder/transport fixture coverage alongside fake SSH pattern                                                                                                                                  |
| MODIFY    | `apps/server/src/ws.ts`                                        | Resolve service and add two thin handlers                                                                                                                                                              |
| MODIFY    | `apps/server/src/server.ts`                                    | Provide service and shared dispatcher at application route composition                                                                                                                                 |
| MODIFY    | `apps/server/src/mcp/McpHttpServer.ts`                         | Remove nested dispatcher provisioning so MCP and WS share one instance                                                                                                                                 |
| MODIFY    | `apps/server/src/mcp/toolkits/worktree/registration.test.ts`   | Import SshRemoteDispatch and add `Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})` to layerStubServices so the production MCP layer still resolves its dispatcher after provisioning moves outward |
| MODIFY    | `apps/server/src/ws.test.ts`                                   | RpcTest handler harness for delegation cases                                                                                                                                                           |
| MODIFY    | `apps/server/src/auth/RpcAuthorization.test.ts`                | Launch each-scope negatives; fetch write negative                                                                                                                                                      |
| MODIFY    | `packages/client-runtime/src/state/vcs.ts`                     | `sshWorkspaceLaunch` / `sshWorkspaceFetchBack` commands                                                                                                                                                |
| MODIFY    | `packages/client-runtime/src/state/commandPermissions.test.ts` | Availability and execution checks for both tags                                                                                                                                                        |

The `McpHttpServer.ts` change is a reported implementation-map expansion needed for shared tunnel/session
ownership, justified by its existing private `Layer.provide(SshRemoteDispatch.layer)` at line 894.
It adds no MCP workspace-sync tools; existing alias-based SSH tools keep their interface.
Its existing test consumer at `mcp/toolkits/worktree/registration.test.ts:84` provides the stub services
declared at `:37-58`, which currently omit the dispatcher. Amend that harness with the explicit test
layer above and keep its production tools-list HTTP assertion; no live SSH dispatcher is needed.

## Contracts: new complete module

Existing anchors: `ipc.ts:388` is the full SSH target; `baseSchemas.ts:31` is PortSchema;
`orchestrationV2.ts:3189` supplies launch conventions; `project.ts:199` already supports scripts.
EnvironmentId is defined at `baseSchemas.ts:318`; mode schemas are at `providerPolicy.ts:25,34`.
The launch accepts text only: assets/context need remote upload and are outside this PR. PR3 must block
such submissions visibly rather than silently discarding content. ModelSelection is sent explicitly;
provider IDs are environment-local, so PR3 must select a remote-valid model.

Create `packages/contracts/src/sshWorkspace.ts` with this complete module:

```ts
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopSshEnvironmentTargetSchema } from "./ipc.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const SshWorkspaceDestination = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  expectedEnvironmentId: EnvironmentId,
  target: DesktopSshEnvironmentTargetSchema,
});
export type SshWorkspaceDestination = typeof SshWorkspaceDestination.Type;

export const SshWorkspaceLaunchInput = Schema.Struct({
  sourceProjectId: ProjectId,
  destination: SshWorkspaceDestination,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  initialMessage: Schema.Struct({ text: Schema.String }),
});
export type SshWorkspaceLaunchInput = typeof SshWorkspaceLaunchInput.Type;

export const SshWorkspaceLaunchResult = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}$/u)),
  snapshotRef: TrimmedNonEmptyString,
  snapshotOid: TrimmedNonEmptyString,
  remoteEnvironmentId: EnvironmentId,
  remoteProjectId: ProjectId,
  remoteThreadId: ThreadId,
  remoteRepoPath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type SshWorkspaceLaunchResult = typeof SshWorkspaceLaunchResult.Type;

export const SshWorkspaceFetchBackInput = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  remoteWorkspaceRoot: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type SshWorkspaceFetchBackInput = typeof SshWorkspaceFetchBackInput.Type;

export const SshWorkspaceFetchBackResult = Schema.Struct({
  sourceProjectId: ProjectId,
  localWorkspaceRoot: TrimmedNonEmptyString,
  localRef: TrimmedNonEmptyString,
  commitOid: TrimmedNonEmptyString,
  remoteBranch: TrimmedNonEmptyString,
});
export type SshWorkspaceFetchBackResult = typeof SshWorkspaceFetchBackResult.Type;

export const SshWorkspaceStage = Schema.Literals([
  "validate",
  "preflight",
  "snapshot",
  "remote_init",
  "push",
  "launch",
  "fetch",
]);
export type SshWorkspaceStage = typeof SshWorkspaceStage.Type;
export const SshWorkspaceCode = Schema.Literals([
  "invalid_target",
  "project_not_found",
  "not_git_repository",
  "project_not_repo_root",
  "project_read_failed",
  "host_unavailable",
  "remote_unsupported",
  "model_unavailable",
  "environment_mismatch",
  "invalid_remote_response",
  "snapshot_failed",
  "unsupported_snapshot",
  "head_changed",
  "secret_candidate",
  "foreign_path",
  "remote_init_failed",
  "push_failed",
  "push_ref_conflict",
  "push_oid_mismatch",
  "launch_refused",
  "launch_uncertain",
  "invalid_branch",
  "source_not_found",
  "source_ambiguous",
  "fetch_failed",
]);
export type SshWorkspaceCode = typeof SshWorkspaceCode.Type;

export class SshWorkspaceError extends Schema.TaggedError<SshWorkspaceError>()(
  "SshWorkspaceError",
  {
    stage: SshWorkspaceStage,
    code: SshWorkspaceCode,
    host: Schema.optional(Schema.String),
    operationId: Schema.optional(Schema.String),
    fileNames: Schema.optional(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    if (this.code === "project_not_repo_root")
      return "Add the repository root as the project before sending this workspace over SSH.";
    if (this.code === "secret_candidate")
      return "Early warning: untracked credential-like files were found; review them before sending.";
    if (this.code === "launch_uncertain")
      return `The thread may have started on ${this.host ?? "the SSH host"}; check its threads before sending again.`;
    return `SSH workspace ${this.stage} failed (${this.code}).`;
  }
}
```

Do not add client-provided cwd/ref/operationId/script/secret-override/callerRuntimeMode fields.
Target strings are validated in the domain service because existing IPC target schemas are deliberately
permissive. Numeric ports must be integers 1..65535. Error attributes never include SSH output,
Git argv, message contents, scripts, keys, bearer tokens, or lower-level defect text.

`packages/contracts/src/index.ts:63` before/after:

```diff
 export * from "./rpc.ts";
+export * from "./sshWorkspace.ts";
```

`packages/contracts/src/rpc.ts:416` add method literals beside VCS methods:

```ts
sshWorkspaceLaunch: "sshWorkspace.launch",
sshWorkspaceFetchBack: "sshWorkspace.fetchBack",
```

At `rpc.ts:1371` add the six schema imports from `./sshWorkspace.ts`, then:

```ts
const WsSshWorkspaceLaunchRpc = Rpc.make(WS_METHODS.sshWorkspaceLaunch, {
  payload: SshWorkspaceLaunchInput,
  success: SshWorkspaceLaunchResult,
  error: Schema.Union([SshWorkspaceError, EnvironmentAuthorizationError]),
});
const WsSshWorkspaceFetchBackRpc = Rpc.make(WS_METHODS.sshWorkspaceFetchBack, {
  payload: SshWorkspaceFetchBackInput,
  success: SshWorkspaceFetchBackResult,
  error: Schema.Union([SshWorkspaceError, EnvironmentAuthorizationError]),
});
```

At `rpc.ts:1974` insert both entries after WsVcsInitRpc in WsRpcGroup. The existing
`.middleware(RpcScopeAuthorization)` at `rpc.ts:2027` covers them. No new transport protocol.

`packages/contracts/src/clientRpcPermissions.ts:37,53` before/after:

```diff
   [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,
+  [WS_METHODS.sshWorkspaceLaunch]: AuthSourceControlWriteScope,
+  [WS_METHODS.sshWorkspaceFetchBack]: AuthSourceControlWriteScope,
@@
 ): readonly AuthEnvironmentScope[] {
+  if (method === WS_METHODS.sshWorkspaceLaunch)
+    return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
   if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
```

Literal evidence: imported constants at `clientRpcPermissions.ts:4-7`; values at
`auth.ts:83` = `orchestration:operate`, `auth.ts:91` = `source-control:write`.
Launch must require both even with undefined input, unlike the payload-dependent existing special case.
`RpcAuthorization.ts:43-44,263-273` already spreads the guarded map and enforces all returned scopes;
no production authorization file change is necessary. Keep exact-coverage test at
`RpcAuthorization.test.ts:34` green.

## Git snapshot extraction: precise modifications

`GitVcsDriver.ts:811-1083` is the existing private-index checkpoint core. `:856-961` preserves
sparse/racy-index behavior; `:981-1032` deliberately skips unborn nested repos; `:1082` cleans index/lock.
Extract in place rather than inventing a second snapshot implementation or changing VcsDriver's public
checkpoint interface. Keep checkpoint behavior/tests unchanged; strict transfer cannot silently exclude files.

Add namespace Schema import and contracts `VcsError` type, then these new types before
`GitVcsDriver.ts:306`:

```ts
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
}
```

Keep the existing GitVcsDriver service interface and layer requirements unchanged. The snapshot
method is returned by the existing `makeVcsDriverShape` factory; SshWorkspaceSync constructs that
shape once inside its make to capture its VcsProcess/FileSystem/Path/Crypto dependencies. This avoids
adding a new required member to every Git driver fake and a new layer dependency to unrelated Git tests.

Replace `GitVcsDriver.ts:811-1083` by the checkpoint wrapper below, and insert this complete
shared function immediately before `const checkpoints` at `:810`. The following is the actual
moved source with strict-mode modifications, not an incomplete skeleton. Existing stat/racy-index,
sparse fallback, nested-repo checkpoint recovery, durable-write and cleanup logic is retained.
Strict mode requires a committed local HEAD, no gitlinks, no conflicts, and no embedded repositories;
untracked paths are read before/after capture and intersected with the captured tree for M4.
The empty old-value on strict update-ref is create-only for either Git object format.

```ts
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
      args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
    });
    if (paths.stdoutTruncated)
      return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
    return splitNullSeparatedGitStdoutPaths(paths);
  });
  const indexConfig = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "sparse.expectFilesOutsideOfPatterns=false",
  ];
  const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
  const indexId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const tempIndexPath = path.join(gitCommonDir, `t3-checkpoint-index-${indexId}`);
  const commitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: tempIndexPath,
    GIT_AUTHOR_NAME: "T3 Code",
    GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
    GIT_COMMITTER_NAME: "T3 Code",
    GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
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
            Effect.mapError(() => new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" })),
          );
        if (embedded) return yield* new GitWorkspaceSnapshotError({ code: "unsupported_snapshot" });
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
        let specialFlags = false;
        let recordStart = true;
        let skipped = false;
        let skippedRecord: number[] = [];
        const skippedPaths: string[] = [];
        yield* vcsProcess.run({
          operation,
          command: "git",
          cwd: input.cwd,
          args: [...indexConfig, "ls-files", "--full-name", "--sparse", "-v", "-z"],
          env: commitEnv,
          maxOutputBytes: 4_096,
          outputMode: "truncate",
          // Inspect every tag; retain only skipped file paths for checking sparse rules.
          onStdoutChunk: (chunk) => {
            for (const byte of chunk) {
              if (recordStart) skipped = byte === 83;
              if (skipped && sparseCheckout) {
                if (byte !== 0) skippedRecord.push(byte);
                else {
                  if (skippedRecord.at(-1) !== 47) {
                    const name = Buffer.from(skippedRecord).subarray(2);
                    if (!NodeBuffer.isUtf8(name)) specialFlags = true;
                    else skippedPaths.push(name.toString("utf8"));
                  }
                  skippedRecord = [];
                }
              }
              if (
                recordStart &&
                ((byte >= 97 && byte <= 122) || (!sparseCheckout && byte === 83))
              ) {
                specialFlags = true;
              }
              recordStart = byte === 0;
            }
          },
        });
        if (skippedPaths.length > 0 && !specialFlags) {
          const selected = yield* execute({
            operation,
            cwd: input.cwd,
            args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
            stdin: skippedPaths.join("\0") + "\0",
            env: commitEnv,
            maxOutputBytes: 1,
            outputMode: "truncate",
          });
          // Any selected skipped file has a manual flag, not a sparse exclusion.
          specialFlags = selected.stdout.length > 0 || selected.stdoutTruncated;
        }
        // Sparse Git clears skip-worktree for present files. Manual flags still need a reset.
        return !specialFlags;
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
            : ["read-tree", capturedHead!],
          env: commitEnv,
        });
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
          "add",
          ...(sparseCheckout ? ["--sparse"] : []),
          "-A",
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
                  args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
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

    const message = input.strict
      ? `t3 snapshot ref=${input.ref}`
      : `t3 checkpoint ref=${input.ref}`;
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
    yield* execute({
      operation,
      cwd: input.cwd,
      args: [...durableWrite, "update-ref", input.ref, commitOid, ...(input.strict ? [""] : [])],
    });
    return { snapshotRef: input.ref, commitOid, addedUntrackedPaths };
  }).pipe(Effect.ensuring(cleanupTempIndex));
});
```

Replace old checkpoint capture callback with:

```ts
captureCheckpoint: (input) => captureTree({
  cwd: input.cwd, ref: input.checkpointRef, strict: false,
}).pipe(
  Effect.asVoid,
  Effect.mapError((error) => error._tag === "GitWorkspaceSnapshotError"
    ? new VcsProcessExitError({
        operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION, command: "git", cwd: input.cwd,
        exitCode: 1, detail: "Checkpoint snapshot capture was refused.",
      })
    : error),
),
```

The error conversion keeps the generic checkpoint error channel as VcsError; strict-specific errors
are unreachable for strict:false but remain in the shared function's inferred union.

At `GitVcsDriver.ts:1303` add a `captureWorkspaceSnapshot` member to makeVcsDriverShape's result:

```ts
captureWorkspaceSnapshot: (input: GitWorkspaceSnapshotInput) => captureTree({
  cwd: input.cwd, ref: input.snapshotRef, strict: true,
}),
```

`GitVcsDriver.ts:1321-1327` remains unchanged. SshWorkspaceSync consumes the shape factory's new
snapshot member directly; VcsProcess is already provided by the server application at `server.ts:1113`.
Tests for strict capture use `makeVcsDriverShape` under the existing Git contract layer at
`GitVcsDriver.test.ts:30-34`. Do not widen the generic VcsDriver interface: snapshots for SSH are
Git-specific. Actual disk content wins over staged-only content. Git ignores exclude nontracked files;
see final Plan conflicts for already tracked ignored files. Private indexes and locks are always cleaned
by ensuring, including interruption. Published local refs are retained for inspection; there is no
operation database or cleanup scheduler.

## Full-target dispatch and scripts: exact edits

Current anchors: SshLaunchInput host at `SshRemoteDispatch.ts:98`, resolveHost at `:303`, launch resolves
alias at `:513`, session cache at `:380` and eviction at `:422`, create arguments at `:590`, launch
arguments at `:614`, service return at `:744`, manager configuration at `:772-790`.

Add type ProjectScript and values EnvironmentId/OrchestratorMcpCapabilitiesResult from contracts, Schema namespace, and
`targetConnectionKey` from `@t3tools/ssh/command`. Replace SshLaunchInput with a type intersection:

```ts
type SshDispatchDestination =
  | { readonly host: string; readonly target?: undefined }
  | { readonly target: DesktopSshEnvironmentTarget; readonly host?: undefined };
export type SshLaunchInput = SshDispatchDestination & {
  readonly cwd: string;
  readonly workspace: SshLaunchWorkspace;
  readonly title: string;
  readonly message?: string | undefined;
  readonly projectTitle?: string | undefined;
  readonly scripts?: ReadonlyArray<ProjectScript> | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly callerRuntimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
};
```

For new project/launch responses, replace loose casts at `:597,623` with hoisted schema decoders:
`Schema.Struct({ id: ProjectId })` and `Schema.Struct({ threadId: ThreadId })`. Add ProjectId/ThreadId
value imports. Decode after callRemote; invalid project acknowledgement is a definite registration
failure, invalid thread acknowledgement sets launchMayHaveStarted=true as specified below. This
covers empty/blank IDs as well as missing IDs; existing casts validate only typeof string.

At `:137` add two service methods:

```ts
readonly runRemoteScript: (input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly script: string;
  readonly timeoutMs: number;
}) => Effect.Effect<{ readonly stdout: string; readonly stderr: string }, SshRemoteDispatchError>;
readonly preflightTarget: (input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: ModelSelection;
}) => Effect.Effect<{ readonly environmentId: EnvironmentId }, SshRemoteDispatchError>;
```

Hoist these compiled decoders beside the module schemas:

```ts
const decodeRemoteIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentId }),
);
const decodeRemoteCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);
```

The capabilities tool schema is at `mcp/toolkits/orchestrator/tools.ts:61-67`; its exact provider/model
fields are `orchestratorMcp.ts:519-555`. The provider instance must be valid in the destination.
Inside make before launchThread, insert:

```ts
const runRemoteScript = Effect.fn("SshRemoteDispatch.runRemoteScript")(function* (input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly script: string;
  readonly timeoutMs: number;
}) {
  return yield* withRuntime(
    manager.runRemoteScript(input.target, {
      script: input.script,
      timeoutMs: input.timeoutMs,
    }),
  ).pipe(sshFailed(input.target.alias));
});
const preflightTarget = Effect.fn("SshRemoteDispatch.preflightTarget")(function* (input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: ModelSelection;
}) {
  const bootstrap = yield* withRuntime(manager.ensureEnvironment(input.target)).pipe(
    sshFailed(input.target.alias),
  );
  const session = yield* sessionFor(input.target, input.runtimeMode);
  if (!session.ceilingApplied)
    return yield* failure("remote_refused", "Update the remote T3 before sending a workspace.");
  const identity = yield* callRemote({
    target: input.target,
    httpBaseUrl: bootstrap.httpBaseUrl,
    ceiling: input.runtimeMode,
    token: session.token,
    tool: "goat_environment_read",
    arguments: {},
  });
  const environment = yield* decodeRemoteIdentity(identity).pipe(
    Effect.mapError(() =>
      failure("remote_refused", "The remote returned no valid environment identity."),
    ),
  );
  const rawCapabilities = yield* callRemote({
    target: input.target,
    httpBaseUrl: bootstrap.httpBaseUrl,
    ceiling: input.runtimeMode,
    token: session.token,
    tool: "orchestrator_capabilities",
    arguments: {},
  });
  const capabilities = yield* decodeRemoteCapabilities(rawCapabilities).pipe(
    Effect.mapError(() =>
      failure("remote_refused", "The remote cannot report model capabilities."),
    ),
  );
  const provider = capabilities.providers.find(
    (entry) => entry.providerInstanceId === input.modelSelection.instanceId,
  );
  if (
    provider === undefined ||
    !provider.models.some((model) => model.id === input.modelSelection.model)
  )
    return yield* new SshRemoteDispatchError({
      reason: "remote_refused",
      remoteCode: "model_unavailable",
      message: "The selected provider instance or model is unavailable on the remote T3.",
    });
  return environment;
});
```

Change only launchThread `:513` to `const target = input.target ?? (yield* resolveHost(input.host!));`.
Full-target callers bypass host discovery: saved explicit targets need not occur in this machine's
known_hosts/config. Alias-based MCP callers still go through current resolveHost/knownHosts checks.
Validate full targets at the RPC service boundary; do not expose scripts/raw shell on the wire.

Replace both session map keys at `:380,422` with
`` `${targetConnectionKey(target)}\u0000${ceiling}` `` (using input.target/input.ceiling for eviction).
This prevents the same alias with a different user/port/hostname from reusing the wrong bearer token.
Preserve connectedHosts alias presentation. Add methods to the object at `:744`.

Project creation arguments change at `:590-596`:

```diff
           workspaceRoot: folder.path,
+          ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
```

Existing registered remote projects are reused with their own scripts; never silently rewrite their
settings. First registration receives the source project's saved scripts exactly, including async and
runOnWorktreeCreate. The entire chain already accepts scripts: `ProjectCreatePayload` (`project.ts:204`)
→ MCP tool spread (`mcp/toolkits/project/tools.ts:72`) → ProjectService.create (`ProjectService.ts:350`)
→ project aggregate. Remote ThreadLaunchService invokes its setup runner at `ThreadLaunchService.ts:543`.
See Plan conflicts for the already-folded settings case; do not change that policy in this PR.

No SshLaunchResult change is required: the service obtains actual environmentId during preflight.
No alias/MCP caller is given `Effect.void` as a replacement for its existing authorization callback.
The user RPC alone supplies the requested thread modes, full-access caller ceiling, and void callback
under the guarded source-session grant. `mcp/toolkits/project/handlers.ts:199` wraps project creation
in `McpToolAccess.writesEnvironment`; `McpToolAccess.ts:262-271` invokes the real full-access check at
`mcp/threadAccess.ts:140-143`. `SshRemoteDispatch.ts:562-567` uses callerRuntimeMode for the session,
while `:618` independently forwards runtimeMode to the thread. A requested approval-required thread
must therefore still register its first remote project under a full-access client session. For this
RPC, preflightTarget's internal runtimeMode parameter also receives full-access as its session ceiling;
it does not set the thread mode.

## SSH workspace service: complete new module

New file `apps/server/src/sshRemote/SshWorkspaceSync.ts`. Dependencies and source evidence:
ProjectService.getById/snapshot `ProjectService.ts:124,132`; GitVcsDriver.execute `GitVcsDriver.ts:309`;
SSH manager key-only auth `SshRemoteDispatch.ts:201-214`; target host specification
`packages/ssh/src/command.ts:86-115`. All shell scripts are constructed inside the service.
Root-validation evidence: `workspace/WorkspacePaths.ts:193` returns the normalized project directory
without enforcing a Git toplevel; `GitVcsDriver.ts:958` reads the whole HEAD tree, and
`SshRemoteDispatch.ts:595` registers folder.path as the remote project root. Require canonical local
root equality before transfer to avoid silently widening a subdirectory project remotely. Use Effect
FileSystem.realPath (existing usage at `workspace/WorkspaceFileSystem.test.ts:164-165`); map resolution
failures to validate/project_read_failed and a proven mismatch to validate/project_not_repo_root.
The Git remote URL supplies `user@alias`; GIT_SSH_COMMAND supplies BatchMode and port. The full saved
target is passed unchanged to dispatch/manager. Existing SSH command behavior uses alias (config selects
HostName), not a manually resolved hostname; use the same alias routing for all three phases.

```ts
import {
  ProjectId,
  ThreadId,
  SshWorkspaceError,
  type DesktopSshEnvironmentTarget,
  type SshWorkspaceLaunchInput,
  type SshWorkspaceLaunchResult,
  type SshWorkspaceFetchBackInput,
  type SshWorkspaceFetchBackResult,
  type SshWorkspaceStage,
  type SshWorkspaceCode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Dispatch from "./SshRemoteDispatch.ts";

const SSH_SCRIPT_TIMEOUT_MS = 30_000;
const GIT_TRANSFER_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 1_000_000;
const safeAlias = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const safeUser = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const safeHostname = /^[A-Za-z0-9_\[][A-Za-z0-9_.:\]-]*$/u;
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const secretName = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12)|id_rsa.*|id_ed25519.*)$/u;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export class SshWorkspaceSync extends Context.Service<
  SshWorkspaceSync,
  {
    readonly launch: (
      input: SshWorkspaceLaunchInput,
    ) => Effect.Effect<SshWorkspaceLaunchResult, SshWorkspaceError>;
    readonly fetchBack: (
      input: SshWorkspaceFetchBackInput,
    ) => Effect.Effect<SshWorkspaceFetchBackResult, SshWorkspaceError>;
  }
>()("t3/sshRemote/SshWorkspaceSync") {}

const make = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  const git = yield* Git.GitVcsDriver;
  const snapshots = yield* Git.makeVcsDriverShape();
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  const validateTarget = Effect.fn("SshWorkspaceSync.validateTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    if (
      !safeAlias.test(target.alias) ||
      !safeHostname.test(target.hostname) ||
      (target.username !== null && !safeUser.test(target.username)) ||
      (target.port !== null &&
        (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535))
    )
      return yield* new SshWorkspaceError({ stage: "validate", code: "invalid_target" });
  });

  // SCP-style URL keeps SSH-config alias semantics; Git supplies this host argument to ssh.
  const remoteHost = (target: DesktopSshEnvironmentTarget) =>
    target.username === null ? target.alias : `${target.username}@${target.alias}`;
  const sshEnvironment = (target: DesktopSshEnvironmentTarget) => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_VARIANT: "ssh",
    GIT_SSH_COMMAND: [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      ...(target.port === null ? [] : ["-p", String(target.port)]),
    ]
      .map(quote)
      .join(" "),
  });
  const repoName = Effect.fn("SshWorkspaceSync.repoName")(function* (workspaceRoot: string) {
    const basename = path.basename(workspaceRoot.replace(/[\\/]+$/u, ""));
    const slug =
      basename
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "") || "repo";
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(workspaceRoot))
      .pipe(Effect.orDie);
    return `${slug}-${Hex.encode(digest).slice(0, 8)}`;
  });
  const script = (
    target: DesktopSshEnvironmentTarget,
    text: string,
    stage: SshWorkspaceStage,
    code: SshWorkspaceCode,
    operationId?: string,
  ) =>
    dispatch.runRemoteScript({ target, script: text, timeoutMs: SSH_SCRIPT_TIMEOUT_MS }).pipe(
      Effect.mapError(
        () =>
          new SshWorkspaceError({
            stage,
            code,
            host: target.alias,
            ...(operationId === undefined ? {} : { operationId }),
          }),
      ),
    );
  const runGit = (
    cwd: string,
    args: ReadonlyArray<string>,
    stage: SshWorkspaceStage,
    code: SshWorkspaceCode,
    target: DesktopSshEnvironmentTarget,
    operationId?: string,
  ) =>
    git
      .execute({
        operation: `SshWorkspaceSync.${stage}`,
        cwd,
        args,
        env: sshEnvironment(target),
        timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
        maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(
          () =>
            new SshWorkspaceError({
              stage,
              code,
              host: target.alias,
              ...(operationId === undefined ? {} : { operationId }),
            }),
        ),
      );

  const initScript = (name: string) => `set -eu
umask 077
repo="$HOME/.goat/repos/${name}"
if [ -e "$repo" ] || [ -L "$repo" ]; then
  if [ -L "$repo" ] || [ ! -d "$repo/.git" ] || [ -L "$repo/.git" ] ||
     [ "$(git -C "$repo" config --local --get goat.managed 2>/dev/null || true)" != true ]; then
    printf 'GOAT_FOREIGN_PATH\\n'
    exit 0
  fi
else
  mkdir -p "$HOME/.goat/repos"
  if mkdir "$repo" 2>/dev/null; then
    git init --quiet "$repo"
    git -C "$repo" config --local goat.managed true
  else
    if [ -L "$repo" ] || [ ! -d "$repo/.git" ] ||
       [ "$(git -C "$repo" config --local --get goat.managed 2>/dev/null || true)" != true ]; then
      printf 'GOAT_FOREIGN_PATH\\n'
      exit 0
    fi
  fi
fi
if [ "$(git -C "$repo" rev-parse --is-bare-repository)" != false ] ||
   [ "$(git -C "$repo" rev-parse --show-toplevel)" != "$repo" ]; then
  printf 'GOAT_FOREIGN_PATH\\n'
  exit 0
fi
printf 'GOAT_REPO\\n%s\\n' "$repo"
`;
  const readRepoPath = Effect.fn("SshWorkspaceSync.readRepoPath")(function* (
    stdout: string,
    target: DesktopSshEnvironmentTarget,
    name: string,
    operationId?: string,
  ) {
    const lines = stdout.trimEnd().split(/\r?\n/u);
    if (lines.at(-1) === "GOAT_FOREIGN_PATH")
      return yield* new SshWorkspaceError({
        stage: "remote_init",
        code: "foreign_path",
        host: target.alias,
        ...(operationId === undefined ? {} : { operationId }),
      });
    const repo = lines.at(-1);
    if (
      lines.at(-2) !== "GOAT_REPO" ||
      repo === undefined ||
      !repo.startsWith("/") ||
      !repo.endsWith(`/.goat/repos/${name}`) ||
      /[\0\r\n]/u.test(repo)
    )
      return yield* new SshWorkspaceError({
        stage: "remote_init",
        code: "invalid_remote_response",
        host: target.alias,
        ...(operationId === undefined ? {} : { operationId }),
      });
    return repo;
  });
  const readOid = Effect.fn("SshWorkspaceSync.readOid")(function* (
    stdout: string,
    stage: SshWorkspaceStage,
    target: DesktopSshEnvironmentTarget,
    operationId?: string,
  ) {
    const oid = stdout.trim();
    if (!oidPattern.test(oid))
      return yield* new SshWorkspaceError({
        stage,
        code: "invalid_remote_response",
        host: target.alias,
        ...(operationId === undefined ? {} : { operationId }),
      });
    return oid;
  });

  const launch = Effect.fn("SshWorkspaceSync.launch")(function* (input: SshWorkspaceLaunchInput) {
    const target = input.destination.target;
    yield* validateTarget(target);
    const found = yield* projects
      .getById(input.sourceProjectId)
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
        ),
      );
    if (Option.isNone(found))
      return yield* new SshWorkspaceError({ stage: "validate", code: "project_not_found" });
    const project = found.value;
    const status = yield* git
      .execute({
        operation: "SshWorkspaceSync.validateRepository",
        cwd: project.workspaceRoot,
        args: ["rev-parse", "--show-toplevel"],
      })
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "not_git_repository" }),
        ),
      );
    if (status.stdoutTruncated || status.stdout.trim().length === 0)
      return yield* new SshWorkspaceError({ stage: "validate", code: "not_git_repository" });
    const canonicalProjectRoot = yield* fileSystem
      .realPath(project.workspaceRoot)
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
        ),
      );
    const canonicalRepoRoot = yield* fileSystem
      .realPath(status.stdout.trim())
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
        ),
      );
    if (canonicalProjectRoot !== canonicalRepoRoot)
      return yield* new SshWorkspaceError({ stage: "validate", code: "project_not_repo_root" });
    const preflight = yield* dispatch
      .preflightTarget({ target, runtimeMode: "full-access", modelSelection: input.modelSelection })
      .pipe(
        Effect.mapError(
          (error) =>
            new SshWorkspaceError({
              stage: "preflight",
              code:
                error.remoteCode === "model_unavailable"
                  ? "model_unavailable"
                  : error.reason === "remote_refused"
                    ? "remote_unsupported"
                    : "host_unavailable",
              host: target.alias,
            }),
        ),
      );
    if (preflight.environmentId !== input.destination.expectedEnvironmentId)
      return yield* new SshWorkspaceError({
        stage: "preflight",
        code: "environment_mismatch",
        host: target.alias,
      });
    const operationId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie))
      .replaceAll("-", "")
      .slice(0, 8);
    const snapshotRef = `refs/goat/snapshots/${operationId}`;
    const pushedRef = `refs/heads/goat/ssh-base/${operationId}`;
    const branch = `goat/ssh/${operationId}`;
    const snapshot = yield* snapshots
      .captureWorkspaceSnapshot({ cwd: project.workspaceRoot, snapshotRef })
      .pipe(
        Effect.mapError(
          (error) =>
            new SshWorkspaceError({
              stage: "snapshot",
              operationId,
              host: target.alias,
              code: error._tag === "GitWorkspaceSnapshotError" ? error.code : "snapshot_failed",
            }),
        ),
      );
    const fileNames = snapshot.addedUntrackedPaths.filter((name) =>
      secretName.test(name.split("/").at(-1) ?? name),
    );
    if (fileNames.length > 0)
      return yield* new SshWorkspaceError({
        stage: "snapshot",
        code: "secret_candidate",
        operationId,
        host: target.alias,
        fileNames,
      });
    const name = yield* repoName(project.workspaceRoot);
    const initialized = yield* script(
      target,
      initScript(name),
      "remote_init",
      "remote_init_failed",
      operationId,
    );
    const remoteRepoPath = yield* readRepoPath(initialized.stdout, target, name, operationId);
    const remote = `${remoteHost(target)}:${remoteRepoPath}`;
    const prior = yield* runGit(
      project.workspaceRoot,
      ["ls-remote", "--refs", remote, pushedRef],
      "push",
      "push_failed",
      target,
      operationId,
    );
    if (prior.stdoutTruncated)
      return yield* new SshWorkspaceError({
        stage: "push",
        code: "invalid_remote_response",
        host: target.alias,
        operationId,
      });
    if (prior.stdout.trim().length > 0 && prior.stdout.split(/\s/u)[0] !== snapshot.commitOid)
      return yield* new SshWorkspaceError({
        stage: "push",
        code: "push_ref_conflict",
        host: target.alias,
        operationId,
      });
    // Create-only publication: an empty lease value makes git refuse the push when the ref already
    // exists on the remote, so a concurrent writer cannot be overwritten between ls-remote and push.
    if (prior.stdout.trim().length === 0)
      yield* runGit(
        project.workspaceRoot,
        [
          "push",
          "--porcelain",
          `--force-with-lease=${pushedRef}:`,
          remote,
          `${snapshotRef}:${pushedRef}`,
        ],
        "push",
        "push_failed",
        target,
        operationId,
      );
    const pushed = yield* runGit(
      project.workspaceRoot,
      ["ls-remote", "--refs", remote, pushedRef],
      "push",
      "push_failed",
      target,
      operationId,
    );
    if (pushed.stdoutTruncated || pushed.stdout.trim() !== `${snapshot.commitOid}\t${pushedRef}`)
      return yield* new SshWorkspaceError({
        stage: "push",
        code: "push_oid_mismatch",
        host: target.alias,
        operationId,
      });
    const remoteThread = yield* dispatch
      .launchThread(
        {
          target,
          cwd: remoteRepoPath,
          projectTitle: project.title,
          scripts: project.scripts,
          workspace: { type: "worktree", baseRef: pushedRef, branch, startFromOrigin: false },
          title: input.title,
          message: input.initialMessage.text,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          callerRuntimeMode: "full-access",
          interactionMode: input.interactionMode,
        },
        Effect.void,
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new SshWorkspaceError({
              stage: "launch",
              operationId,
              host: target.alias,
              code:
                error.launchMayHaveStarted === true
                  ? "launch_uncertain"
                  : error.reason === "remote_refused" || error.reason === "invalid_request"
                    ? "launch_refused"
                    : "launch_uncertain",
            }),
        ),
      );
    return {
      operationId,
      snapshotRef,
      snapshotOid: snapshot.commitOid,
      remoteEnvironmentId: preflight.environmentId,
      remoteProjectId: ProjectId.make(remoteThread.projectId),
      remoteThreadId: ThreadId.make(remoteThread.threadId),
      remoteRepoPath,
      branch,
    } satisfies SshWorkspaceLaunchResult;
  });

  const fetchBack = Effect.fn("SshWorkspaceSync.fetchBack")(function* (
    input: SshWorkspaceFetchBackInput,
  ) {
    const { target, branch } = input;
    yield* validateTarget(target);
    // Query home without creating/adopting a repository; fetch-back is not initialization.
    const homeResult = yield* script(
      target,
      'printf "GOAT_HOME\\n%s\\n" "$HOME"\n',
      "fetch",
      "host_unavailable",
    );
    const homeLines = homeResult.stdout.trimEnd().split(/\r?\n/u);
    const home = homeLines.at(-1);
    if (
      homeLines.at(-2) !== "GOAT_HOME" ||
      home === undefined ||
      !home.startsWith("/") ||
      /[\0\r\n]/u.test(home)
    )
      return yield* new SshWorkspaceError({
        stage: "fetch",
        code: "invalid_remote_response",
        host: target.alias,
      });
    const localProjects = yield* projects.snapshot.pipe(
      Effect.mapError(
        () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
      ),
    );
    const matches = [];
    for (const project of localProjects.projects) {
      if (
        `${home}/.goat/repos/${yield* repoName(project.workspaceRoot)}` ===
        input.remoteWorkspaceRoot.replace(/\/+$/u, "")
      )
        matches.push(project);
    }
    if (matches.length !== 1)
      return yield* new SshWorkspaceError({
        stage: "validate",
        code: matches.length === 0 ? "source_not_found" : "source_ambiguous",
        host: target.alias,
      });
    const project = matches[0]!;
    const localRef = `refs/remotes/goat-ssh/${target.alias}/${branch}`;
    // Full refs alone accept refs/heads/-x, so reject a leading '-' explicitly; check-ref-format below
    // owns every other rule (space, control, ~^:?*[\, '..', '@{'), so valid Unicode/punctuation names pass.
    if (branch.length === 0 || branch.startsWith("-"))
      return yield* new SshWorkspaceError({
        stage: "validate",
        code: "invalid_branch",
        host: target.alias,
      });
    // Full refs avoid check-ref-format --branch accepting @{-1} expansion.
    yield* runGit(
      project.workspaceRoot,
      ["check-ref-format", `refs/heads/${branch}`],
      "validate",
      "invalid_branch",
      target,
    );
    yield* runGit(
      project.workspaceRoot,
      ["check-ref-format", localRef],
      "validate",
      "invalid_branch",
      target,
    );
    const marker = yield* script(
      target,
      `set -eu\nrepo=${quote(input.remoteWorkspaceRoot.replace(/\/+$/u, ""))}\n` +
        'if [ -L "$repo" ] || [ ! -d "$repo/.git" ] || [ -L "$repo/.git" ] || ' +
        '[ "$(git -C "$repo" config --local --get goat.managed 2>/dev/null || true)" != true ]; then ' +
        'printf "GOAT_FOREIGN_PATH\\n"; else printf "GOAT_MANAGED\\n"; fi\n',
      "fetch",
      "fetch_failed",
    );
    if (marker.stdout.trimEnd().split(/\r?\n/u).at(-1) !== "GOAT_MANAGED")
      return yield* new SshWorkspaceError({
        stage: "fetch",
        code: "foreign_path",
        host: target.alias,
      });
    yield* runGit(
      project.workspaceRoot,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        `${remoteHost(target)}:${input.remoteWorkspaceRoot.replace(/\/+$/u, "")}`,
        `+refs/heads/${branch}:${localRef}`,
      ],
      "fetch",
      "fetch_failed",
      target,
    );
    const resolved = yield* runGit(
      project.workspaceRoot,
      ["rev-parse", "--verify", `${localRef}^{commit}`],
      "fetch",
      "fetch_failed",
      target,
    );
    if (resolved.stdoutTruncated)
      return yield* new SshWorkspaceError({
        stage: "fetch",
        code: "invalid_remote_response",
        host: target.alias,
      });
    const commitOid = yield* readOid(resolved.stdout, "fetch", target);
    return {
      sourceProjectId: project.id,
      localWorkspaceRoot: project.workspaceRoot,
      localRef,
      commitOid,
      remoteBranch: branch,
    } satisfies SshWorkspaceFetchBackResult;
  });
  return SshWorkspaceSync.of({ launch, fetchBack });
});
export const layer = Layer.effect(SshWorkspaceSync, make);
```

The init script above is the exact transmitted POSIX shell text after the safe repo name is substituted.
It adopts only marker-bearing non-bare repos at the exact Git root. A failed first init leaves an
unmarked directory; later calls refuse it rather than repair or delete a foreign path. Concurrent
initialization may return foreign_path while the winning initializer has not yet published its marker;
surface that error, no automatic retry. All remote root refs remain unborn.

Local push uses Git, never `ssh git push`, rsync, or a remote local-checkout mutation. For saved target
`{alias:"buildbox",hostname:"buildbox.example",username:"runner",port:2222}`, the builder produces
`GIT_SSH_COMMAND="'ssh' '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=10' '-p' '2222'"` and Git's remote is
`runner@buildbox:/home/runner/.goat/repos/<name>`. Git appends user@alias and receive-pack arguments.
Same-ref/same-OID is transfer success; different OID refuses. Push is create-only publication via
`--force-with-lease=<ref>:`: the empty expected value requires the ref to remain absent at push time.
A ref created between ls-remote and push causes push_ref_conflict or push_failed, preserves that ref,
and never launches. Ref generation and snapshot create-only publication also refuse an opId collision;
do not generate/relaunch on error.

Remote paths, shell interpolation, and source project identity are server-derived. The only fetch
input path permitted is the derived managed root, never the remote thread worktreePath. Reject an
empty branch or a leading `-`, then run check-ref-format for the full `refs/heads/<branch>` and the
destination ref; that rejects refspec colon, glob, `..`, `@{` and control characters while accepting
valid names such as `feature/한글` and `feature/foo+bar` (tests cover both plus `-x` rejection).
The branch reaches git only as an argv element, never a shell. Fetch's leading `+` is permitted only for the dedicated local tracking ref,
so a rewritten remote branch can be fetched; it is never a force push. `--no-write-fetch-head` keeps
even FETCH_HEAD unchanged. No merge/pull/update of a local branch. Truncated responses fail closed.

Name/host/path helper functions need no exports; test through service effects and real temp repositories.
The service does not retry launch. Extend `SshRemoteDispatchError` at `:45` with
`readonly launchMayHaveStarted?: boolean | undefined;`. In `callRemote` at `:419`, construct a
SshRemoteDispatchError with this flag when the tool is goat_thread_launch and transport failed; keep
401 a definite remote refusal. Replace the missing-threadId error at `:625` with:

```ts
return (
  yield *
  new SshRemoteDispatchError({
    reason: "remote_refused",
    launchMayHaveStarted: true,
    message:
      "The remote launch returned no thread acknowledgement; inspect its threads before retrying.",
  })
);
```

Transport mapping at `:428-431` becomes:

```ts
return new SshRemoteDispatchError({
  reason: "ssh_failed",
  message: `Calling ${input.tool} on ${input.target.alias} failed: ${describe(error)}`,
  ...(input.tool === "goat_thread_launch" ? { launchMayHaveStarted: true } : {}),
});
```

The service mapper above gives this flag precedence over reason. Structured remote refusals stay
launch_refused. Invalid acknowledgements become launch_uncertain. No request is repeated to discover state.

## Layer/handler/client integration

`apps/server/src/ws.ts:1203` resolves ProjectService. Add import namespace SshWorkspaceSync and resolve
`const sshWorkspace = yield* SshWorkspaceSync.SshWorkspaceSync;` in layerWsRpc. At `:2849` add:

```ts
[WS_METHODS.sshWorkspaceLaunch]: (input) => sshWorkspace.launch(input),
[WS_METHODS.sshWorkspaceFetchBack]: (input) => sshWorkspace.fetchBack(input),
```

No inline Git/shell/model logic. The RPC schema encodes the service error and the group middleware
checks scopes before entering either method. Existing ws.test.ts tests exported helpers rather than
building layerWsRpc; add a focused RpcTest group harness with a sync-service fake for new delegation
cases. No existing ws.test layer needs a fabricated service dependency. No server/browser start.

`apps/server/src/server.ts:698-728` is application-owned route composition. Add imports for dispatcher
and sync service and define immediately above layerMakeRoutes:

```ts
const layerSshWorkspace = SshWorkspaceSync.layer.pipe(
  Layer.provide(GitVcsDriver.layer),
  Layer.provide(RuntimeLayer.layerProjectService),
);
```

Then provide services in dependency order on layerMakeRoutes (outer provides satisfy inner layers):

```diff
 ).pipe(
+  Layer.provide(layerSshWorkspace),
+  Layer.provide(SshRemoteDispatch.layer),
   Layer.provide(layerPullRequestService),
```

Platform, VcsProcess, FetchHttpClient, config, Crypto, and Path are already provided by the server's
application layer (`server.ts:301,1111-1113`). Reuse existing Layer constants so Effect memoizes them;
do not build another managed runtime. `McpHttpServer.ts:892-895` before/after:

```diff
 ).pipe(
-  // One dispatch for the SSH and thread tools, so they share tunnels, sessions and connected hosts.
-  Layer.provide(SshRemoteDispatch.layer),
   Layer.provideMerge(layerMcpTransport),
 );
```

Leave its SshRemoteDispatch namespace import if toolkit registration consumes it. The outer server
now owns one dispatcher for MCP and WS and closes its local tunnels on shutdown; leaveRemoteServerRunning
remains true (`SshRemoteDispatch.ts:782`). Focused MCP harnesses must supply the same dispatcher dependency.
In `mcp/toolkits/worktree/registration.test.ts`, add a namespace import from
`../../../sshRemote/SshRemoteDispatch.ts`, then amend the existing layerStubServices at `:37`:

```diff
 const layerStubServices = Layer.mergeAll(
+  Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
   Layer.mock(Orchestrator.OrchestratorV2)({}),
```

Its existing `:84` McpHttpServer.layer composition then resolves the dispatcher from the test layer,
keeping the `production mcp layer lists worktree tools over http` integration case operational.
This verifies dependency provisioning and tools registration; it performs no SSH dispatch.

`packages/client-runtime/src/state/vcs.ts:297` has guarded Git commands; `runtime.ts:744-809` owns command
execution and permissionAtom. At the returned object next to createWorktree, insert:

```ts
sshWorkspaceLaunch: createEnvironmentRpcCommand(runtime, {
  label: "environment-data:vcs:ssh-workspace-launch",
  tag: WS_METHODS.sshWorkspaceLaunch,
  concurrency: { mode: "serial", key: (target) => `${target.environmentId}:${target.input.sourceProjectId}` },
}),
sshWorkspaceFetchBack: createEnvironmentRpcCommand(runtime, {
  label: "environment-data:vcs:ssh-workspace-fetch-back",
  tag: WS_METHODS.sshWorkspaceFetchBack,
}),
```

Do not reuse invalidateRefs with these inputs: it requires input.cwd (`vcs.ts:273`) and neither RPC
accepts that field. PR4 uses returned localWorkspaceRoot for ref/status invalidation after success;
PR2's fetched ref is immediately resolvable by Git. No raw client calls outside rpc/. Existing package
export `./state/vcs` already exposes these members; no package.json or new client runtime module needed.
The serial launch lane prevents concurrent sends from one mounted command; it does not deduplicate
distinct requests and no retry claim is made. RPC must run on the source/local environment, not the
remote EnvironmentId used for navigation.

## PLAN-FIELD-CHAIN-01: every new value

Encoding is the existing Effect RPC JSON transport; WsRpcGroup schema decodes before handlers, and
its success/error schema encodes back to the typed client. No custom serializer or operation persistence.

| Value                                                                                    | Creation → serialization → deserialization → consumers                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `destination.connectionId`                                                               | PR3 selected saved catalog route → launch input schema → service input → correlation only; no server auth decision; draft persistence is PR3                                                                                                                                               |
| `destination.expectedEnvironmentId`                                                      | Catalog's saved environment → RPC input → service → compare actual preflight identity before snapshot/push                                                                                                                                                                                 |
| `destination.target.alias/hostname/username/port`                                        | Saved DesktopSshEnvironmentTarget → reused IPC target schema in launch → service validates → script/dispatch manager, session cache key, Git URL/SSH command; fetch input repeats saved target                                                                                             |
| `sourceProjectId`                                                                        | PR3 local draft project → ProjectId RPC codec → getById → source workspace, naming, snapshot, scripts; not a client cwd                                                                                                                                                                    |
| `title`                                                                                  | Draft title → TrimmedNonEmptyString codec → service → dispatcher → MCP title schema → remote launch                                                                                                                                                                                        |
| `modelSelection`                                                                         | Remote-valid composer selection → ModelSelection codec → service → dispatcher tool args → existing MCP ModelSelection schema → remote provider launch; no local default substitution                                                                                                       |
| `runtimeMode` / internal `callerRuntimeMode`                                             | User composer choice → RuntimeMode codec → service → dispatch runtimeMode → remote thread mode unchanged. Guarded local RPC authority → fixed full-access preflight/session ceiling and callerRuntimeMode → remote project-create permission check; callerRuntimeMode is not a wire input. |
| `interactionMode`                                                                        | Composer choice → ProviderInteractionMode codec → service → dispatcher → MCP schema → remote thread mode                                                                                                                                                                                   |
| `initialMessage.text`                                                                    | Draft text → Schema.String RPC → service → dispatch.message → remote MCP message → remote initial turn; attachments/context N/A because unsupported transfer excluded                                                                                                                      |
| `operationId`                                                                            | Server UUID first8 → ref/branch names; RPC result/error codec → client → PR3 error feedback; no input/receipt storage                                                                                                                                                                      |
| `snapshotRef` / `snapshotOid`                                                            | Git create-only hidden ref/private snapshot commit → success codec → client → diagnostics; oid also immutable remote push/readback gate                                                                                                                                                    |
| `remoteEnvironmentId`                                                                    | Remote goat_environment_read response → schema decode in preflight → match expected → success codec → PR3 transient navigation (no draft promotion)                                                                                                                                        |
| `remoteProjectId` / `remoteThreadId`                                                     | Remote MCP structured response → existing dispatch response validation, brand construction → result codec → PR3 waits/navigates remote shell; no local thread created                                                                                                                      |
| `remoteRepoPath`                                                                         | Verified remote HOME + derived repo name/init sentinel → service → result codec → PR3/PR4 remote project root matching, not worktree path                                                                                                                                                  |
| `branch`                                                                                 | Server `goat/ssh/<opId>` → dispatch workspaceStrategy → remote MCP schema → remote worktree binding → result codec → initial UI provenance; PR4 reads thread's current branch for renamed cases                                                                                            |
| `scripts`                                                                                | Local ProjectService snapshot persisted scripts → dispatch input (internal) → MCP JSON `goat_project_create` → ProjectCreatePayload.scripts → remote ProjectService/aggregate → remote setup runner; no new wire input; folded-settings caveat below                                       |
| `remoteWorkspaceRoot` / fetch `branch`                                                   | PR4 current remote project root/current thread branch + saved target → fetch input codec → local derived-project match/check-ref-format → Git fetch; no receipt needed                                                                                                                     |
| `sourceProjectId` / `localWorkspaceRoot` in fetch result                                 | Unique matched local Project → result codec → PR4 ref invalidation/notification                                                                                                                                                                                                            |
| `localRef` / `commitOid` / `remoteBranch`                                                | Validated alias+branch, fetched ref and rev-parse → result codec → PR4 success/compare instructions; no checkout consumer                                                                                                                                                                  |
| `stage` / `code` / `host` / `fileNames`                                                  | Domain error activation → SshWorkspaceError codec → typed client failure → PR3/PR4 actionable feedback; fileNames from added-untracked list only; no file content                                                                                                                          |
| `preflightTarget`, `runRemoteScript`, full dispatch target/scripts and snapshot `strict` | Internal typed service creation → N/A wire except existing MCP calls → internal consumers above; not client RPC fields                                                                                                                                                                     |
| primary scopes/multi-scope list                                                          | Constants/map → N/A JSON fields; server and client both import → middleware and permissionAtom/authorize paths                                                                                                                                                                             |

No new SQL schema, persisted enum, settings field, or migration exists in wp2. PR3 owns draft destination
rehydration and default reset; on success it navigates, then consumes the draft only when its content still
equals the submitted snapshot (030 conditional consumption); no promotion.
PR4 cannot fetch an arbitrary root or a stale launch-only branch.

## Tests: exact files, cases, and activation evidence

All test cases below are planned additions unless explicitly described as an existing case. Tests use
temp directories through scoped fixtures; no live ~/.goat or ~/.t3 writes and no real SSH host. Await
Deferred milestones or drain effect workers; no sleeps/polling. Use real Git for the private index,
unborn receiver, transfer refs, and preserved local state. Dispatch fake only replaces SSH/MCP transport.

| Exact test file                                                | Named cases and concrete behavior/activation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/sshWorkspace.test.ts` (NEW)            | `round trips launch and fetchBack through JSON schemas`: valid target with null/default and explicit user/port; outputs and each stage/code encoded/decoded. `requires source project, destination identity and user modes`: remove required keys, blank project/title, unknown runtime/interaction enum; decode fails. `does not expose operation receipts or secret overrides`: result/input construction has no receipt/connect/override authority; extra object keys cannot affect service. `round trips safe snapshot and uncertain-launch errors`: file names/opId/host retained, no lower error text. `round trips project_not_repo_root and actionable message`: validate stage and code survive JSON; message tells the user to add the repository root as the project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/contracts/src/rpc.test.ts`                           | `registers only the two SSH workspace methods`: look up exact tags and payload/success/error schemas in WsRpcGroup; no readOperation/connect. `applies scope middleware to SSH workspace RPCs`: exercise RpcTest authorization middleware instead of schema presence only. Existing payload compatibility tests remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/server/src/vcs/GitVcsDriver.test.ts`                     | `workspace snapshot captures HEAD plus current tracked and untracked disk content`: commit file, stage one value, overwrite another value, delete tracked file, add untracked, ignore .env; inspect snapshot tree/parent. `workspace snapshot preserves index HEAD working tree and merge state`: byte compare real index and relevant Git state before/after; no branch move. `workspace snapshot rejects unresolved index conflicts`: manufacture unmerged stages; unsupported_snapshot before publish. `workspace snapshot rejects HEAD movement before publishing`: fake execute barrier on write-tree, move HEAD, resume, expect head_changed/no ref. `workspace snapshot refuses unborn local repository`: git init without commit, unsupported_snapshot. `workspace snapshot refuses embedded repositories and gitlinks`: unborn/committed nested repo and initialized submodule, no silent omission. `workspace snapshot rejects truncated path scans`: fake bounded ls-files/ls-tree output flags. `workspace snapshot cleans private index and lock on Git failure and interruption`: filter failure plus Deferred-controlled interruption; scoped cleanup. `strict snapshot uses create-only refs`: prepopulate same ref, refuse overwrite. Existing checkpoint nested-repo/racy/sparse/index suites retain old semantics. `workspace snapshot preserves cone sparse paths and refuses unsupported non-cone recovery`: exercise actual sparse checkout from existing fixtures. |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts`                 | `SSH workspace transport passes BatchMode explicit user alias and port`: adapt :1229 fake ssh to log argv and exec local receive-pack/upload-pack; assert no password prompt and both commands use same destination. `SSH workspace push propagates key-auth refusal`: fake ssh exits 255; push_failed, no dispatch. Existing :1968 rename test is currently failing; do not claim suite green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/server/src/sshRemote/SshRemoteDispatch.test.ts`          | `launch accepts saved full target without rediscovering its alias`: fake manager records exact object; no config discovery needed. `alias launch remains compatible`: current host-only path still rejects unknown host. `same alias different user or port gets a separate session`: two targets and ceilings, two tokens, correct token used for each tool. `scripts reach new remote project creation`: capture goat_project_create args and round-trip ProjectCreatePayload, retain async/setup flags. `existing remote project retains scripts`: no project create/update called. `preflight reads actual environment identity and refuses old remote`: :400 withRemote fake ceilingApplied=false and malformed identity; no snapshot begins. `launch missing acknowledgement is uncertain and not retried`: remote accepts but throws/returns no threadId; launchMayHaveStarted true, exactly one thread-launch request. `structured remote refusal is definite`: remote isError true, typed refusal, no retry. `first registration permits an approval-required thread under full-access ceiling`: extend the fake remote boundary to exercise the real project-create access check if feasible, assert session full-access and goat_thread_launch.runtimeMode approval-required.                                                                                                                                                                                                  |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts`   | Existing `production mcp layer lists worktree tools over http` remains passing after the explicit dispatcher test layer is supplied; tools-list HTTP assertions prove the production MCP layer builds and registers tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/server/src/sshRemote/SshWorkspaceSync.test.ts` (NEW)     | Cases are expanded in the activation table below; compose real Git layer, ProjectService test layer, and dispatcher fake with scoped receiver/home. Assert every forbidden side effect has zero calls, and success order is project/Git realpath-root validation→identity/model preflight→snapshot→init→push→readback→dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/server/src/auth/RpcAuthorization.test.ts`                | `SSH launch rejects missing source-control write before handler`: scopes only orchestration:operate; requiredPermission source-control:write and handled=false. `SSH launch rejects missing orchestration operate before handler`: scopes only source-control:write; requiredPermission orchestration:operate and handled=false. `SSH fetchBack rejects read-only grant before handler`: no source-control:write; handled=false. `SSH fetchBack permits source-control write without orchestration operate`: handler runs. Use :327 RpcTest pattern with each new tag. Exact RPC map coverage remains at :34.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/client-runtime/src/state/commandPermissions.test.ts` | `SSH launch availability and execution require both grants`: create actual command, test each missing grant, permissionAtom=false and run failure, no request. `SSH fetchBack requires only source-control write`: matching permissionAtom and execution; orchestration-only denied. `SSH launch rechecks source environment grant after serial queue`: adapt :148 lane barrier, revoke grant while queued; second command sends zero RPC. `SSH command cannot borrow a grant from the selected remote environment`: grant remote but deny source-local, fail on local destination.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/server/src/ws.test.ts`                                   | `SSH workspace handlers delegate once and preserve typed errors`: focused RpcTest group handlers with sync service fake; launch input/output and fetch input/output exact, one call, SshWorkspaceError preserved; authorization middleware tested separately above. Existing helper tests remain unchanged; this harness needs no live server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Service activation table (C-ACTIVATION-GROUNDING-01): each row is a named test case in
`apps/server/src/sshRemote/SshWorkspaceSync.test.ts`; every emitted code has a reachable stimulus.

| Named case                                                                  | Stimulus                                                                                                          | Expected stage/code and proof                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejects unsafe alias user hostname and invalid ports before SSH`           | Alias `-oProxyCommand`, slash alias, whitespace username, newline hostname, 0/65536/fractional port               | validate/invalid_target; no script/preflight/Git                                                                                                                                              |
| `rejects missing source project`                                            | getById none                                                                                                      | validate/project_not_found; zero transfer                                                                                                                                                     |
| `maps failed project reads without output leakage`                          | getById or snapshot fails                                                                                         | validate/project_read_failed; no cause in wire                                                                                                                                                |
| `rejects non Git source`                                                    | temp ordinary folder                                                                                              | validate/not_git_repository; no remote call                                                                                                                                                   |
| `rejects a subdirectory project before snapshot`                            | Temp committed repo with apps/server registered as project.workspaceRoot                                          | validate/project_not_repo_root; message asks to add repository root; zero preflight/snapshot/init/push/launch                                                                                 |
| `accepts a repository root through a symlink`                               | Project root symlink resolves to the same Git toplevel                                                            | Root validation succeeds; managed name still hashes stored workspaceRoot string                                                                                                               |
| `maps canonical root read failure`                                          | FileSystem.realPath fails for project root or returned Git toplevel                                               | validate/project_read_failed; zero snapshot/remote work                                                                                                                                       |
| `maps unavailable SSH preflight`                                            | fake ensure fails/key-only auth refusal                                                                           | preflight/host_unavailable; no snapshot/push                                                                                                                                                  |
| `rejects obsolete remote before snapshot`                                   | fake preflight ceiling/schema refusal                                                                             | preflight/remote_unsupported; no transfer                                                                                                                                                     |
| `rejects remote provider or model unavailable before snapshot`              | Capabilities omit instanceId or requested model                                                                   | preflight/model_unavailable; no snapshot/push                                                                                                                                                 |
| `rejects saved environment identity mismatch`                               | actual identity differs from expected                                                                             | preflight/environment_mismatch; no snapshot                                                                                                                                                   |
| `rejects unsupported or changed snapshot`                                   | SnapshotError unsupported/head_changed fixture                                                                    | snapshot/unsupported_snapshot or head_changed; no init/push                                                                                                                                   |
| `maps Git snapshot failure`                                                 | rejecting clean filter/permission                                                                                 | snapshot/snapshot_failed; cleanup and no init                                                                                                                                                 |
| `warns on every untracked secret-name pattern`                              | visible `.env`, `.env.test`, `x.pem`, `x.key`, `id_rsa.pub`, `id_ed25519`, `x.p12`, nested matching names         | snapshot/secret_candidate; exact fileNames, zero push/launch                                                                                                                                  |
| `ignored secret paths never enter snapshot`                                 | .gitignore ignores .env and .pem                                                                                  | success without warning; receiver tree excludes them                                                                                                                                          |
| `tracked secret files illustrate documented early-warning bypass`           | Commit .env before snapshot                                                                                       | guard does not warn; test documents M4 residual risk, not enforcement                                                                                                                         |
| `newly staged secret files also bypass the early warning`                   | Create .env, stage it in the real index without committing, then snapshot                                         | guard does not warn; captured tree includes .env; original index unchanged; documents M4 residual risk                                                                                        |
| `initializes receiver once without a root checkout`                         | Empty fake remote HOME then init twice                                                                            | marker true, non-bare, same root, HEAD remains unborn                                                                                                                                         |
| `refuses foreign file directory repo or symlink`                            | Four existing path kinds without goat.managed=true                                                                | remote_init/foreign_path; byte-for-byte existing contents unchanged                                                                                                                           |
| `maps remote init shell failure`                                            | fake remote script reports failed git/mkdir                                                                       | remote_init/remote_init_failed; no push                                                                                                                                                       |
| `rejects malformed init and Git responses`                                  | Missing GOAT_REPO/path, truncated refs, invalid fetch oid                                                         | stage remote_init/push/fetch with invalid_remote_response; no downstream effect                                                                                                               |
| `pushes snapshot then launches remote owned worktree`                       | Local dirty temp repo, non-bare unborn receiver, fake SSH executing git-receive-pack                              | Correct tree, parent, immutable base ref; dispatch target/scripts/modes exact; beforeLaunch yields void; callerRuntimeMode full-access and runtimeMode requested                              |
| `dispatch uses full-access caller ceiling for every requested runtime mode` | Parameterize approval-required, auto-accept-edits, auto, full-access from RuntimeMode                             | Dispatch receives {callerRuntimeMode:"full-access", runtimeMode:<requested>}; preflight ceiling full-access; user interactionMode preserved                                                   |
| `existing identical remote ref is transfer success`                         | ls-remote fake/receiver returns same OID                                                                          | No second push; proceed after exact readback                                                                                                                                                  |
| `different remote snapshot ref refuses push`                                | Existing pushedRef different OID                                                                                  | push/push_ref_conflict; existing OID unchanged, no push/no dispatch                                                                                                                           |
| `ref created between ls-remote and push prevents launch`                    | Deferred barrier after absent ls-remote result; fixture creates remote ref with another OID before releasing push | Empty expected-value lease rejects push; push/push_ref_conflict or push_failed; concurrent OID unchanged; zero launch                                                                         |
| `maps SSH push failure`                                                     | fake ssh exit255 / rejecting pre-receive hook                                                                     | push/push_failed; no dispatch                                                                                                                                                                 |
| `refuses wrong pushed OID`                                                  | Readback different/missing/truncated oid                                                                          | push/push_oid_mismatch; no launch                                                                                                                                                             |
| `definite launch refusal retains source snapshot`                           | remote structured refusal invalid model/runtime                                                                   | launch/launch_refused; local state/ref preserved, one launch attempt                                                                                                                          |
| `lost launch acknowledgement is never relaunched`                           | request accepted then no response/malformed threadId                                                              | launch/launch_uncertain with host+operationId; exact one dispatch, no automatic retry                                                                                                         |
| `fetch finds local source by M3 derived root`                               | Several same-basename roots; remote root matching one hash                                                        | Correct sourceProjectId; ref+OID returns from that local repo                                                                                                                                 |
| `fetch refuses missing or ambiguous source match`                           | Different root, or duplicated same workspaceRoot test rows                                                        | validate/source_not_found or source_ambiguous; no fetch                                                                                                                                       |
| `fetch refuses invalid branch refspecs`                                     | Colon/glob/.., empty segment, -x, leading dash, @{-1}, option-like/ref expansion values                           | validate/invalid_branch from the empty/leading-dash guard then full check-ref-format; -x fails the guard despite valid refs/heads/-x; feature/한글 and feature/foo+bar are accepted; no fetch |
| `fetch refuses foreign receiver marker`                                     | Matched root but marker missing                                                                                   | fetch/foreign_path; no fetch                                                                                                                                                                  |
| `fetch maps home lookup or remote read failure`                             | SSH home script fails/malformed output; branch absent/SSH upload-pack refuses                                     | fetch/host_unavailable, invalid_remote_response or fetch_failed as applicable; no local checkout changes                                                                                      |
| `fetch preserves HEAD index worktree FETCH_HEAD and writes dedicated ref`   | Commit remote branch, dirty local index/tree, existing FETCH_HEAD                                                 | returned localRef and commitOid match receiver; byte comparisons unchanged                                                                                                                    |
| `fetch refreshes rewritten remote branch in tracking namespace`             | Second remote branch commit not fast-forward from first                                                           | Only refs/remotes/goat-ssh/alias/branch changes; local branches unaffected                                                                                                                    |

For the successful fake-SSH fixture, take `GitVcsDriverCore.test.ts:1229-1243` executable-file/env pattern;
parse/record ssh arguments in the fixture, run Git's requested receive-pack/upload-pack against the
test-owned remote path, and reject unexpected commands. The dispatcher fake follows
`SshRemoteDispatch.test.ts:400-476`, recording tools/manager target and using Deferred for lost-response
activation. RuntimeMode's four cases are verified at `packages/contracts/src/providerPolicy.ts:25-30`.
The existing withRemote helper at `SshRemoteDispatch.test.ts:400-476` fakes HTTP replies and does not
exercise project-create authorization. For the conditional first-registration case, extend it to carry
issued ceiling/tool arguments and run the real `McpToolAccess.writesEnvironment` project-create access
path (`mcp/toolkits/project/handlers.ts:199`, `McpToolAccess.ts:262-271`, `threadAccess.ts:140-143`).
If the harness cannot supply that real access context within scope, return that coverage gap to the
parent; a canned project-create success is not proof of the check. The all-mode service dispatch
assertions remain required regardless. Real SSH is never reached.
`GitVcsDriver.test.ts:120-163` demonstrates exact index-byte
comparison. Test helpers in NEW test modules may be local; no new reusable production abstraction.

Add a focused integration case to the existing `ProjectSetupScriptRunner.test.ts` only after parent
resolves the folded-settings conflict below. It must use remote project scripts with runOnWorktreeCreate
and assert actual terminal execution, not just field forwarding; that is an explicitly deferred conflict,
not a green verifier claim. The file is not in this PR's settled change map.

## PLAN-VERIFIER-REAL-01: commands and current-tree evidence

All commands below execute from the shared checkout. Prefix **every** command with:

```sh
PATH=/Users/jun/.goat/worktrees/goat/t3-8cf0da21/node_modules/.bin:$PATH
```

In one executable shell block, export it once (PATH prepend, not replacement):

```sh
cd /Users/jun/.goat/worktrees/goat/t3-8cf0da21
export PATH=/Users/jun/.goat/worktrees/goat/t3-8cf0da21/node_modules/.bin:$PATH
vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/vcs/GitVcsDriver.test.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/src/auth/RpcAuthorization.test.ts packages/client-runtime/src/state/commandPermissions.test.ts packages/contracts/src/rpc.test.ts
vp run --filter t3 typecheck
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/client-runtime typecheck
vp lint packages/contracts/src/clientRpcPermissions.ts packages/contracts/src/rpc.ts packages/contracts/src/index.ts apps/server/src/vcs/GitVcsDriver.ts apps/server/src/sshRemote/SshRemoteDispatch.ts apps/server/src/ws.ts apps/server/src/server.ts packages/client-runtime/src/state/vcs.ts
```

These exact five commands were run on the **current tree**, before any implementation. Package script
names were checked in package.json: server package is **t3**, contracts and client-runtime use scoped
names. No repo-wide check or typecheck occurred.

| Executed command                                       | Exit  | Reads change target?                                                            | Observed result / limit                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp test run` with six exact existing test files above | **1** | Yes, existing Git/dispatch/auth/client/RPC target behavior; new behavior absent | 6 files, 271 tests: 270 passed, 1 failed. `GitVcsDriverCore.test.ts:1968`, `preserves renames, unusual paths, modes, and binary statistics`: TypeError reading undefined `stat.previousPath`. No source edit by this worker. |
| `vp run --filter t3 typecheck`                         | 0     | Yes, all server sources/test imports including intended existing modifications  | tsc --noEmit, cache disabled; suggestions only. NEW service/types are absent, so this is baseline proof.                                                                                                                     |
| `vp run --filter @t3tools/contracts typecheck`         | 0     | Yes, contracts package                                                          | Suggestions only; new schemas absent.                                                                                                                                                                                        |
| `vp run --filter @t3tools/client-runtime typecheck`    | 0     | Yes, client-runtime command owners                                              | Suggestions only; new commands absent.                                                                                                                                                                                       |
| `vp lint` with eight exact existing source files above | 0     | Yes, all eight supplied paths                                                   | Four existing warnings: rpc.ts:284 empty import; ws.ts:9 Fiber, :16 Schedule, :1249 projectSetupScriptRunner unused. NEW files/tests/MCP layer edit not included.                                                            |

The independent audit reports the rename/diff failure reproduced on unmodified dev; it is pre-existing,
not a regression from this docs-only change, and is never claimed green. Its source case starts at
`GitVcsDriverCore.test.ts:1938` and fails when reading stat.previousPath at `:1968`. The document has
no green implementation claim; the historical whole-file failure above remains disclosed.

PR2 acceptance evidence is **local macOS** `vp test run <exact new/changed server, contracts,
client-runtime test files>` exit 0 (including the filtered new SSH transport cases below), plus hosted
**goat-ci check/typecheck/build** passing on the exact final PR head. Hosted goat-ci's test step only
runs @t3tools/ssh and @t3tools/web (`.github/workflows/goat-ci.yml:65-70`), plus a build-script test at
`:72-75`; it does not prove server/contracts/client-runtime behavior. The matrix/check/typecheck/build
steps are at `:26,57-63,77-85`. Do not describe hosted goat-ci test success as PR2 behavior evidence.
Do not change the workflow in this unit. Use -t only for the new GitVcsDriverCore SSH transport cases;
the other new/changed test files run without test-name filtering. This excludes the known unrelated
failure from acceptance commands without erasing its baseline failure evidence.

After implementation, run the expanded focused commands (NOT RUN here: NEW files do not yet exist;
these extend an existing real runner, not invented scripts):

```sh
vp test run packages/contracts/src/sshWorkspace.test.ts packages/contracts/src/rpc.test.ts apps/server/src/sshRemote/SshWorkspaceSync.test.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/src/vcs/GitVcsDriver.test.ts apps/server/src/auth/RpcAuthorization.test.ts packages/client-runtime/src/state/commandPermissions.test.ts apps/server/src/ws.test.ts apps/server/src/mcp/toolkits/worktree/registration.test.ts
vp test run apps/server/src/vcs/GitVcsDriverCore.test.ts -t 'SSH workspace transport passes BatchMode explicit user alias and port|SSH workspace push propagates key-auth refusal'
vp run --filter t3 typecheck
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/client-runtime typecheck
vp lint packages/contracts/src/sshWorkspace.ts packages/contracts/src/sshWorkspace.test.ts packages/contracts/src/rpc.ts packages/contracts/src/rpc.test.ts packages/contracts/src/index.ts packages/contracts/src/clientRpcPermissions.ts apps/server/src/sshRemote/SshWorkspaceSync.ts apps/server/src/sshRemote/SshWorkspaceSync.test.ts apps/server/src/sshRemote/SshRemoteDispatch.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriver.test.ts apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/ws.ts apps/server/src/ws.test.ts apps/server/src/server.ts apps/server/src/mcp/McpHttpServer.ts apps/server/src/auth/RpcAuthorization.test.ts packages/client-runtime/src/state/vcs.ts packages/client-runtime/src/state/commandPermissions.test.ts apps/server/src/mcp/toolkits/worktree/registration.test.ts
```

Additional current-tree coverage was run for the mapped existing ws helper tests and MCP/test files:

```sh
vp test run apps/server/src/ws.test.ts
vp lint apps/server/src/mcp/McpHttpServer.ts apps/server/src/ws.test.ts apps/server/src/vcs/GitVcsDriver.test.ts apps/server/src/vcs/GitVcsDriverCore.test.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/src/auth/RpcAuthorization.test.ts packages/contracts/src/rpc.test.ts packages/client-runtime/src/state/commandPermissions.test.ts
```

| Executed additional command              | Exit | Reads change target?                       | Result                                                                                      |
| ---------------------------------------- | ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `vp test run apps/server/src/ws.test.ts` | 0    | Yes, existing ws exports; not new handlers | 1 file, 8 tests passed                                                                      |
| `vp lint` exact MCP/test files above     | 0    | Yes, every listed path                     | Three existing schema-compile warnings: rpc.test.ts:22,29 and GitVcsDriverCore.test.ts:1965 |

Do not replace an absent new module with a passing empty test selection. Browser/mobile verification
is N/A: wp2 is service/contracts/shared commands only; integrated desktop UI proof belongs to the parent
following PR3. After folding B2/B4/B5/B7 and the non-blocking audit findings, the complete contracts
module (86 lines), shared capture function (318 lines), and sync-service module (258 lines) were passed
to `transformWithOxc` from the installed vite-plus package in a read-only Node stdin script.
All three parsed with zero syntax errors, exit 0; no source or temporary file was written. A read-only
Python document-consistency check also exited 0: ceiling/mode separation, all four mode fixtures,
canonical-root gate/schema/fixture, registration harness/verifier entries, local-vs-hosted evidence,
filtered transport tests, branch rule, lease-race activation, staged-secret bypass, and balanced fences
were present. No new vp test/typecheck/lint command was run during this amendment; the commands and
baseline results above remain historical evidence, not fresh proof of the amended implementation.
The earlier worker's first parser attempt using installed `typescript` failed (exit 1): this workspace
exposes only its version stub, not transpileModule/ScriptTarget. Its Vite parser check succeeded before
these amendments. The fresh checks are syntax/document consistency only, not type or behavior proof.

## Commit and PR draft

Implementation commits (parent owns git; not executed by this worker):

1. `feat(contracts): define guarded SSH workspace launch and fetch RPCs`
2. `refactor(server): share private-index snapshot capture for SSH transfer`
3. `feat(server): sync managed SSH workspaces and fetch thread branches`
4. `feat(client-runtime): expose guarded SSH workspace commands`

PR title: `feat(server): launch remote worktrees from local workspace snapshots`

Body draft:

> Starting a worktree on another machine currently requires the project to exist there, and the
> remote launch does not carry local uncommitted files. This adds a service that captures local Git
> state without changing the checkout, pushes it to a managed repository under ~/.goat/repos, and
> launches the worktree through the remote T3. A guarded fetch-back RPC returns a dedicated local
> tracking ref without changing HEAD or the index.
>
> Launch requires source-control:write and orchestration:operate; fetch-back requires source-control:write.
> Full saved SSH targets, immutable snapshot refs, an untracked secret-name early warning, and source
> path matching are covered by focused Git/SSH/authorization tests. There are no automatic launch retries.
>
> Validation: fill with exact final-head targeted test/typecheck/lint results. Current design baseline
> has one existing Git diff-preview test failure; it is not evidence for implementation acceptance.
>
> Stack: PR1 <link> → **PR2 this PR** → PR3 <link> → PR4 <link>. Base: goat/ws-picker-1-local-default.
>
> Model and harness: fill with the implementation executor's observed model and harness.

The stack placeholders and final validation/model fields are deliberate PR-time values. Do not post
this draft or fill them with this docs worker's identity. No UI screenshots required for this backend PR.

## Risks and bounded limitations

- No receipts/idempotent remote launch: accepted lost response can mean a running remote thread.
  Every such result keeps the draft; there is exactly one remote launch attempt. Explicit resubmission
  is a new operation and may duplicate work. PR3 must render the warning and avoid automatic retry.
- Eight-hex opId/hash suffix collisions are possible. Create-only snapshot refs and exact source-match
  ambiguity guards refuse collisions; remote base refs cannot be force-replaced.
- The source server's SSH config/agent must authenticate saved aliases. Full target user/port is carried;
  alias-to-hostname consistency follows existing SSH manager behavior (see Plan conflicts).
- Snapshot is a Git index-based view of disk, not an atomic filesystem snapshot. Concurrent edits may
  produce a mixed tree; HEAD movement is rejected. Submodules/embedded repos and incomplete path reads
  fail rather than give a false transfer-complete result. LFS content/filter behavior needs focused
  fixture coverage if such projects are supported; Git pointers alone do not transfer external blobs.
- Ignored untracked .env files are excluded. Tracked files (including newly staged, uncommitted secrets
  already tracked in the real index) and reachable history can include secrets;
  M4 is a filename early warning, not content enforcement. The server never prints file contents.
- Remote init has no transaction/automatic repair. Interrupted init can leave an unmarked directory
  that later calls refuse. Remote project scripts are trusted user configuration and may be platform
  dependent; setup outcome remains owned/visible on the remote thread.
- Launch result means remote thread accepted, not setup completed or turn succeeded. Remote worktree
  path and setup lifecycle stay with ThreadLaunchService. Fetch-back returns committed branch state,
  including rewritten branches, and does not recover uncommitted remote files.
- Desktop-first: plain browser cannot establish saved SSH transport; A12 gateway remains rejected.
  Mobile consumes compatible contracts/commands but gets no SSH picker UI in this unit.

## Plan conflicts

1. **A10 script passthrough does not itself guarantee setup execution on a folded remote.**
   `ProjectService.ts:350` stores supplied aggregate scripts, but
   `ProjectSetupScriptRunner.ts:369` calls `resolveProjectScripts`; its
   `packages/shared/src/projectScripts.ts:23` returns remote settings.defaultProjectScripts when
   projectSettingsFolded is true, ignoring aggregate project.scripts unless there is a settings override.
   The authoritative plan says scripts passed to goat_project_create make the local setup run remotely.
   Implement the specified passthrough; parent must resolve this demonstrated settings-policy conflict
   before claiming that outcome. No override RPC or settings-policy change is silently added here.
2. **Full target hostname is not the actual destination selector in the existing SSH implementation.**
   `packages/ssh/src/command.ts:86-91,187-208` builds user@alias and port; hostname is used for keys/logging,
   not an explicit HostName override. The A10 intent to preserve saved hostname/user/port can disagree
   with an edited/stale SSH config alias. This design carries the full target and keeps Git/manager
   destination selection consistent; parent decides whether hostname override belongs in the shared
   SSH boundary. Do not silently route only Git to a different hostname.
3. **Literal "gitignored files excluded" differs from native tracked-file semantics.**
   `GitVcsDriver.ts:969-979` stages `git add -A`, which still captures tracked paths matching ignore
   rules. `000_plan.md` requires ignored exclusion while M4 explicitly limits warning to untracked
   files and allows committed-secret and newly staged-secret bypass. The proposed extraction retains native Git semantics;
   parent owns any clarification about tracked ignored paths. No history rewrite or blanket secret
   enforcement is added.

The missing server explorer map is an input evidence gap, not a decision conflict. The baseline
rename/diff test failure is verification debt, not a conflict with M1-M6. The unborn remote receiver
remains a plan assumption requiring the new temp-repo success test, not grounds to add an anchor branch.
