import * as AuxiliarySqlite from "./storage/AuxiliarySqlite.ts";
// @effect-diagnostics nodeBuiltinImport:off - seeds another GOAT app's database the way its server writes it.
// @effect-diagnostics preferSchemaOverJson:off - fakes the projection rows the cleanup reads.

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";

import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as SqlClient from "effect/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as WorktreeSnapshotStoreLive from "./worktreeSnapshots/WorktreeSnapshotStoreLive.ts";
import { WorktreeCleanupPreviewState } from "./worktreeSnapshots/WorktreeCleanupPreviewState.ts";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";

import { shell } from "./storageCleanup.testFixtures.ts";
import { OpenHandleRunnerRef } from "./worktreeSnapshots/openHandles.ts";

// The rules this file's older cases were written for; new default-on rules have their own cases.
export const LEGACY_WORKTREE_RULES = {
  worktreeAfterDays: null,
  worktreeOnDelete: false,
  worktreeOnArchive: false,
  worktreeKeepRecent: null,
  worktreeSnapshotChanges: false,
} as const;
// The preview is off by default, so cleanup must never consult it; storageCleanupRun.test.ts covers it on.
const unusedPreview = Layer.succeed(WorktreeCleanupPreviewState, {
  evaluate: () => Effect.die("cleanup consulted the preview while it is off"),
  respond: () => Effect.die("cleanup answered a preview while it is off"),
  reset: Effect.void,
});
export const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    ...LEGACY_WORKTREE_RULES,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" }));
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = path.join(config.worktreesDir, "feature");
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    let settings: import("@goat/contracts").ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let deletedThreads: OrchestrationV2ThreadShell[] = [];
    let storedWorktreePaths: string[] = [worktree];
    let projectRoots = [repo];
    let editBeforeRemoval = false;
    let openSessionCwd: string | null = null;
    let sessionLive = true;
    let onLiveCheck: Effect.Effect<void> = Effect.void;
    let outboxStatus: string | null = null;
    let fullStatusCalls = 0;
    let gitfileDiagnostic: string | null = null;
    let snapshotReads = 0;
    let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const cleanupLayer = StorageCleanup.layer.pipe(
      Layer.provide(AuxiliarySqlite.layer),
      Layer.provide(Layer.merge(WorktreeSnapshotStoreLive.layer, unusedPreview)),
      Layer.provide(NodeCrypto.layer),
    );
    const context = yield* Layer.build(cleanupLayer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            if (
              editBeforeRemoval &&
              (input.args.includes("remove") || input.args.includes("--porcelain"))
            )
              yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
            const result = yield* git.execute(input);
            return gitfileDiagnostic !== null &&
              input.operation === "StorageCleanup.branchChanged" &&
              result.exitCode !== 0
              ? { ...result, stderr: gitfileDiagnostic }
              : result;
          }),
        statusDetailsLocal: (...args) => {
          fullStatusCalls++;
          return git.statusDetailsLocal(...args);
        },
      }),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot }))),
        listShells: () =>
          Effect.sync(() =>
            projectRoots.map((workspaceRoot, index) => ({
              id: ProjectId.make(`project-${index + 1}`),
              workspaceRoot,
            })),
          ),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.sync(() => {
            snapshotReads++;
            const visible = threads.filter((thread) => thread.deletedAt === null);
            return {
              threads:
                input?.location === "archive"
                  ? []
                  : visible.filter((thread) => thread.archivedAt === null),
              archivedThreads:
                input?.location === "active"
                  ? []
                  : visible.filter((thread) => thread.archivedAt !== null),
            };
          }),
        getReviewLedgerEntries: () => Effect.die("unused review ledger query"),
        getThreadWorktreePaths: (input?: { includeArchived?: boolean }) =>
          Effect.sync(() =>
            threads.flatMap((thread) =>
              thread.deletedAt === null &&
              (input?.includeArchived === true || thread.archivedAt === null) &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () =>
          Effect.sync(() => sessionLive).pipe(Effect.tap(() => Effect.suspend(() => onLiveCheck))),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(SqlClient.SqlClient, ((strings: TemplateStringsArray) =>
        Effect.sync(() =>
          openSessionCwd !== null && strings.join("").includes("projection_provider_sessions")
            ? [
                {
                  payload_json: JSON.stringify({
                    id: "session-1",
                    driver: "codex",
                    providerInstanceId: "codex",
                    status: "ready",
                    cwd: openSessionCwd,
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: "2026-06-01T12:00:00.000Z",
                    updatedAt: "2026-06-01T12:00:00.000Z",
                    lastError: null,
                  }),
                },
              ]
            : outboxStatus !== null && strings.join("").includes("orchestration_v2_effect_outbox")
              ? [{ status: outboxStatus }]
              : strings.join("").includes("deleted_at IS NOT NULL")
                ? deletedThreads.map((thread) => ({
                    payload_json: JSON.stringify(thread),
                    workspaceRoot: repo,
                  }))
                : strings.join("").includes('AS "worktreePath"')
                  ? [
                      ...threads.flatMap((thread) => thread.worktreePath ?? []),
                      ...storedWorktreePaths,
                    ].map((worktreePath) => ({ worktreePath }))
                  : [],
        )) as unknown as SqlClient.SqlClient),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: (
          listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
        ) =>
          Effect.sync(() => {
            terminalListener = listener;
            return () => {};
          }),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      repo,
      setTerminals: (terminals: TerminalSummary[]) =>
        terminalListener?.({ type: "snapshot", terminals }) ?? Effect.void,
      editBeforeRemoval: () => {
        editBeforeRemoval = true;
      },
      fs,
      path,
      worktree,
      config,
      command,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      disable: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      setOnLiveCheck: (hook: Effect.Effect<void>) => {
        onLiveCheck = hook;
      },
      setOutboxStatus: (status: string | null) => {
        outboxStatus = status;
      },
      setDeletedThreads: (next: OrchestrationV2ThreadShell[]) => {
        deletedThreads = next;
      },
      setStoredWorktreePaths: (paths: string[]) => {
        storedWorktreePaths = paths;
      },
      setProjectRoots: (roots: string[]) => {
        projectRoots = roots;
      },
      setSessionLive: (live: boolean) => {
        sessionLive = live;
      },
      setOpenSessionCwd: (cwd: string | null) => {
        openSessionCwd = cwd;
      },
      openTerminal: (paths: { cwd: string; worktreePath: string | null }) =>
        terminalListener?.({
          type: "upsert",
          terminal: {
            threadId: "thread-1",
            terminalId: "terminal-1",
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: "2026-06-10T12:00:00.000Z",
            ...paths,
          },
        }) ?? Effect.void,
      fullStatusCalls: () => fullStatusCalls,
      setGitfileDiagnostic: (diagnostic: string | null) => {
        gitfileDiagnostic = diagnostic;
      },
      snapshotReads: () => snapshotReads,
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) => {
        events = domainEvents;
        return Deferred.succeed(activated, undefined);
      },
    };
  });
export const pausedMeasurementFixture = (storageCleanup?: StorageCleanupSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measuring = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let measuredPath: string | undefined;
    const fixture = yield* cleanupFixture(storageCleanup).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (directory, options) =>
          Effect.gen(function* () {
            if (directory === measuredPath) {
              yield* Deferred.succeed(measuring, undefined);
              yield* Deferred.await(resume);
            }
            return yield* fs.readDirectory(directory, options);
          }),
      }),
    );
    measuredPath = yield* fs.realPath(fixture.worktree);
    return { ...fixture, measuring, resume };
  });
export const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);
export const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) =>
  effect.pipe(
    // Never the developer's home: cleanup reads other local GOAT apps' databases from it.
    Effect.provideService(HostProcess.HomeDirectory, "/nonexistent/goat-cleanup-test-home"),
    // A complete, empty listing unless a test asks for the host's lsof.
    Effect.provideService(OpenHandleRunnerRef, async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
    Effect.provide(cleanupTestLayer),
    Effect.scoped,
  );
