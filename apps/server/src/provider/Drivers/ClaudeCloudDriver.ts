import {
  ClaudeCloudSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";
import * as PtyAdapter from "@goat/shared/PtyAdapter";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import type { ProviderDriver } from "@goat/provider-core/server/driver";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import { withInstanceIdentity } from "@goat/provider-core/server/instanceIdentity";
import {
  ClaudeCloudCli,
  ClaudeCloudError,
  makeClaudeCloudAdapter,
} from "@goat/provider-claude-cloud/server";
import { resolveClaudeCloudLogin } from "./ClaudeCloudLogin.ts";
import * as PullRequests from "../../pullRequest/PullRequestService.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { makeClaudeCloudFolderTrust } from "./ClaudeCloudFolderTrust.ts";

const DRIVER = ProviderDriverKind.make("claudeCloud");
const decodeSettings = Schema.decodeSync(ClaudeCloudSettings);
export type ClaudeCloudDriverEnv =
  | ProviderHost.ProviderHost
  | Path.Path
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | PtyAdapter.PtyAdapter
  | PullRequests.PullRequestService
  | Projection.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient;

export const ClaudeCloudDriver: ProviderDriver<ClaudeCloudSettings, ClaudeCloudDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Claude Cloud",
    supportsMultipleInstances: true,
    hasDefaultInstance: true,
  },
  configSchema: ClaudeCloudSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const pullRequests = yield* PullRequests.PullRequestService;
      const projection = yield* Projection.ProjectionStoreV2;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const pty = yield* PtyAdapter.PtyAdapter;
      const processEnvironment = yield* HostProcess.Environment;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const platform = yield* HostProcess.Platform;
      const operations = yield* Effect.gen(function* () {
        return yield* ClaudeCloudCli.ClaudeCloudCli;
      }).pipe(
        Effect.provide(ClaudeCloudCli.layer),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(PtyAdapter.PtyAdapter, pty),
      );
      const resolveLogin = resolveClaudeCloudLogin(config.sourceInstanceId).pipe(
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Environment, processEnvironment),
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        Effect.provideService(HostProcess.Platform, platform),
      );
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: `claudeCloud:${instanceId}:${config.sourceInstanceId}`,
      });
      const base = (status: ServerProvider["status"], message?: string): ServerProvider =>
        stamp({
          executionLocation: "cloud",
          authSourceInstanceId: ProviderInstanceId.make(config.sourceInstanceId),
          enabled,
          installed: false,
          version: null,
          status,
          auth: { status: "unknown" },
          checkedAt: "1970-01-01T00:00:00.000Z",
          models: [
            {
              slug: "cloud-default",
              name: "Cloud default",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
          supportedRuntimeModes: ["approval-required"],
          supportsConversationRollback: false,
          supportsTextGeneration: false,
          reportsContextWindow: false,
          showInteractionModeToggle: false,
          setup: { canAuthenticate: false, canInstall: false },
          ...(message ? { message } : {}),
        });
      // Environment-owned, empty of project source. Keep HOME/config/env from the sibling.
      const controlCwd = path.join(
        host.paths.providerStatusCacheDir,
        "claude-cloud-control",
        encodeURIComponent(instanceId),
      );
      const resolveControlCwd = fileSystem.makeDirectory(controlCwd, { recursive: true }).pipe(
        Effect.as(controlCwd),
        Effect.mapError(
          () =>
            new ClaudeCloudError({
              detail:
                "Could not prepare the environment-owned Claude control directory. No prompt was sent.",
              outcome: "rejected",
            }),
        ),
      );
      const check = Effect.gen(function* () {
        if (!enabled) return base("disabled");
        const login = yield* resolveLogin;
        const result = yield* operations.readiness(login, yield* resolveControlCwd);
        return {
          ...base("ready"),
          installed: true,
          version: result.version,
          auth: { status: "authenticated" as const, type: "claude.ai" },
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          message:
            "Claude Cloud starts tasks from the project folder. Local changes may be included. Waits for a session-linked GitHub PR for up to two hours; PR presence does not confirm passing checks.",
        };
      }).pipe(Effect.catch((cause) => Effect.succeed(base("error", cause.detail))));
      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
        getSettings: host.settings.get,
        streamSettings: host.settings.changes,
        haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
        initialSnapshot: () => Effect.succeed(base(enabled ? "warning" : "disabled")),
        checkProvider: check,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not build Claude Cloud readiness.",
              cause,
            }),
        ),
      );
      const folderTrust = makeClaudeCloudFolderTrust({
        instanceId,
        sql,
        projects: projectStore,
        projection,
        fileSystem,
        path,
        resolveLogin,
        cli: operations,
      });
      const orchestrationAdapter = yield* makeClaudeCloudAdapter({
        instanceId,
        resolveLogin,
        resolveControlCwd,
        folderTrust: folderTrust.policy,
        observe: (input) =>
          pullRequests.findCloudSessionPullRequest(input).pipe(
            Effect.mapError(
              () =>
                new ClaudeCloudError({
                  detail: "Cannot observe GitHub PRs for this project's persisted source.",
                  outcome: "uncertain",
                }),
            ),
          ),
        runStartedAt: (input) =>
          projection.getThreadRecords(input.threadId, ["runs"]).pipe(
            Effect.mapError(
              () =>
                new ClaudeCloudError({
                  detail: "Could not read the persisted cloud observation deadline.",
                  outcome: "uncertain",
                }),
            ),
            Effect.flatMap((records) => {
              const run = records.runs.find((item) => item.id === input.runId);
              return run?.startedAt
                ? Effect.succeed(run.startedAt)
                : Effect.fail(
                    new ClaudeCloudError({
                      detail:
                        "The persisted run has no observation start time; the deadline will not be reset.",
                      outcome: "uncertain",
                    }),
                  );
            }),
          ),
      }).pipe(Effect.provideService(ClaudeCloudCli.ClaudeCloudCli, operations));
      const unsupportedText = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              "Choose a local provider for text generation; Claude Cloud submits coding sessions.",
          }),
        );
      return {
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        enabled,
        continuationIdentity: {
          driverKind: DRIVER,
          continuationKey: `claudeCloud:${instanceId}:${config.sourceInstanceId}`,
        },
        snapshot,
        orchestrationAdapter,
        folderTrust: folderTrust.capability,
        textGeneration: {
          generateCommitMessage: () => unsupportedText("commitMessage"),
          generatePrContent: () => unsupportedText("prContent"),
          generateBranchName: () => unsupportedText("branchName"),
          generateThreadTitle: () => unsupportedText("threadTitle"),
          generateReviewGuide: () => unsupportedText("reviewGuide"),
        },
      };
    }),
};
