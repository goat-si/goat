// @effect-diagnostics nodeBuiltinImport:off - non-secret random fixture bytes exercise the compressed bundle cap.
import * as PressureNudger from "../fleet/pressure/PressureNudger.ts";
import { assert } from "@effect/vitest";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import {
  OrchestrationV2CheckpointJson,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  EnvironmentId,
  type OrchestrationV2Checkpoint,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Launches from "../orchestration-v2/ThreadLaunchService.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Replicas from "./ThreadReplicaService.ts";
import * as Checkpoints from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";

const sourceId = ThreadId.make("source");
const runId = RunId.make("completed-run");
const projectId = ProjectId.make("project");
const encodeCheckpoint = Schema.encodeSync(OrchestrationV2CheckpointJson);
const decodeCheckpoint = Schema.decodeUnknownSync(OrchestrationV2CheckpointJson);
const checkpointJson = Schema.fromJsonString(OrchestrationV2CheckpointJson);
const persistedCheckpoint = (checkpoint: OrchestrationV2Checkpoint) =>
  Schema.decodeSync(checkpointJson)(Schema.encodeSync(checkpointJson)(checkpoint));
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "test-model",
} as const;
const authorize = Effect.succeed({
  runtimeMode: "full-access",
  interactionMode: "default",
} as const);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-recovery-test-" });
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  yield* fs.makeDirectory(source);
  const git = (cwd: string, ...args: string[]) =>
    runner
      .run({
        command: "git",
        args,
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(root, "no-config"),
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
      })
      .pipe(
        Effect.map((result) => {
          assert.strictEqual(result.code, 0, result.stderr);
          return result.stdout.trimEnd();
        }),
      );
  yield* git(source, "init", "-q", "-b", "main");
  yield* fs.writeFileString(path.join(source, "tracked"), "base\n");
  yield* git(source, "add", ".");
  yield* git(source, "commit", "-qm", "base");
  const base = yield* git(source, "rev-parse", "HEAD");
  yield* git(root, "clone", "-q", source, destination);
  yield* git(source, "remote", "add", "origin", "https://github.com/example/replica-test.git");
  yield* git(source, "update-ref", "refs/remotes/origin/main", base);
  yield* git(
    destination,
    "remote",
    "set-url",
    "origin",
    "https://github.com/example/replica-test.git",
  );
  yield* fs.writeFileString(path.join(source, "unpushed"), "unpushed commit\n");
  yield* git(source, "add", ".");
  yield* git(source, "commit", "-qm", "unpushed");
  const head = yield* git(source, "rev-parse", "HEAD");
  yield* fs.writeFileString(path.join(source, "tracked"), "captured dirty\n");
  yield* fs.writeFileString(path.join(source, "new-file"), "captured new\n");
  const now = yield* DateTime.now;
  const checkpointLayer = Checkpoints.layer.pipe(
    Layer.provide(CheckpointStore.layer.pipe(Layer.provide(VcsRegistry.layer))),
    Layer.provide(IdAllocator.layer),
    Layer.provide(VcsProcess.layer),
    Layer.provide(Config.layerTest(root, root)),
    Layer.provide(NodeServices.layer),
  );
  const checkpointScope = {
    id: CheckpointScopeId.make("replica-scope"),
    threadId: sourceId,
    runId,
    nodeId: NodeId.make("source-node"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-source"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: source,
    createdAt: DateTime.makeUnsafe(0),
  } as const;
  const produceCheckpoint = Checkpoints.CheckpointServiceV2.pipe(
    Effect.flatMap((service) =>
      service.capture({
        scope: checkpointScope,
        runId,
        nodeId: NodeId.make("source-node"),
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: now,
      }),
    ),
    Effect.provide(checkpointLayer),
    Effect.tap((checkpoint) => Effect.sync(() => assert.strictEqual(checkpoint.status, "ready"))),
  );
  const checkpoint = yield* produceCheckpoint;
  const checkpointId = checkpoint.id;
  const ref = checkpoint.ref;
  const commit = yield* git(source, "rev-parse", ref);
  // A later live edit must not leak into the completed checkpoint.
  yield* fs.writeFileString(path.join(source, "tracked"), "later edit\n");
  const sourceThread = {
    id: sourceId,
    projectId,
    worktreePath: source,
    runtimeMode: "full-access",
    interactionMode: "default",
    deletedAt: null,
    archivedAt: null,
  } as const;
  let projection = {
    thread: sourceThread,
    runs: [{ id: runId, ordinal: 1, status: "completed", checkpointId, modelSelection }],
    checkpoints: [persistedCheckpoint(checkpoint)],
    visibleTurnItems: [
      {
        item: { type: "user_message", runId, text: "Implement the requested fix", updatedAt: now },
      },
      {
        item: {
          type: "assistant_message",
          runId,
          text: "The first part is complete",
          streaming: false,
          updatedAt: now,
        },
      },
      {
        item: {
          type: "user_message",
          runId: RunId.make("later"),
          text: "FUTURE INPUT MUST NOT COPY",
          updatedAt: now,
        },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const restoreLocal = (checkpoint: OrchestrationV2Checkpoint) =>
    Checkpoints.CheckpointServiceV2.pipe(
      Effect.flatMap((service) => service.restore({ scope: checkpointScope, checkpoint })),
      Effect.provide(checkpointLayer),
    );
  const captureCheckpoint = produceCheckpoint.pipe(
    Effect.tap((produced) =>
      Effect.sync(() => {
        projection = {
          ...projection,
          checkpoints: [persistedCheckpoint(produced)],
        };
      }),
    ),
  );
  const launches: Launches.ThreadLaunchInput[] = [];
  const stored = new Map<string, { input: Launches.ThreadLaunchInput; hasRun: boolean }>();
  let failAt: "none" | "before_thread" | "after_thread" | "after_run" = "none";
  const settings = yield* Settings.ServerSettingsService.pipe(
    Effect.provide(
      Settings.layerTest({ fleet: { hosts: { box: { maxThreads: 3, allowGoals: false } } } }),
    ),
  );
  let pressureBlocked = false;
  const dependencies = Layer.mergeAll(
    Layer.mock(PressureNudger.PressureAdmissionService)({
      admit: (host) =>
        Effect.succeed({
          refuse: pressureBlocked,
          advice: pressureBlocked
            ? { host, level: "critical", message: "fixture pressure", alternatives: [] }
            : undefined,
        }),
    }),
    Layer.mock(Providers.ProviderInstanceRegistry)({
      getInstance: (id) =>
        Effect.succeed(
          id === "missing"
            ? undefined
            : ({
                enabled: true,
                snapshot: {
                  getSnapshot: Effect.succeed({
                    enabled: true,
                    installed: id !== "uninstalled",
                    status: "ready",
                    auth: { status: id === "signedout" ? "unauthenticated" : "authenticated" },
                  }),
                },
                orchestrationAdapter: {
                  getCapabilities: () =>
                    Effect.succeed({
                      sessions: { executionLocation: id === "cloud" ? "cloud" : "local" },
                    } as never),
                },
              } as never),
        ),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadSnapshotWindow: () =>
        Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
      getThreadShell: (id) =>
        Effect.sync(() => {
          const entry = stored.get(id);
          return entry === undefined
            ? null
            : ({
                id,
                projectId,
                worktreePath:
                  entry.input.workspaceStrategy.type === "existing_worktree"
                    ? entry.input.workspaceStrategy.worktreePath
                    : null,
              } as never);
        }),
      getThreadRecords: (id) =>
        id === sourceId
          ? Effect.succeed({
              runs: projection.runs,
              checkpoints: projection.checkpoints,
              turnItems: [
                { type: "checkpoint", checkpointId, id: TurnItemId.make("checkpoint-item") },
              ],
            } as never)
          : Effect.sync(() => {
              const entry = stored.get(id);
              const message = entry?.input.initialMessage;
              return {
                runs:
                  entry?.hasRun && message !== undefined
                    ? [{ id: RunId.make("recovered-run"), userMessageId: message.messageId }]
                    : [],
              } as never;
            }),
    }),
    Layer.mock(Projects.ProjectStoreV2)({
      get: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({ id: projectId, workspaceRoot: destination } as never)
            : Option.none(),
        ),
    }),
    Layer.mock(Launches.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          const { threadId, initialMessage } = input;
          if (threadId === undefined || initialMessage === undefined) {
            return yield* Effect.die("Expected a recovery thread and message");
          }
          launches.push(input);
          if (failAt !== "before_thread")
            stored.set(threadId, { input, hasRun: failAt !== "after_thread" });
          if (failAt !== "none")
            return yield* new Launches.ThreadLaunchError({
              operation: "dispatch-message",
              commandId: input.commandId,
              projectId,
              cause: "response lost",
            });
          return {
            threadId,
            resumed: false,
            projection: {
              runs: [{ id: RunId.make("recovered-run"), userMessageId: initialMessage.messageId }],
            } as never,
          };
        }),
    }),
    Layer.mock(Environment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("source-env")),
    }),
    Repository.layer,
    Config.layerTest(root, root),
    Layer.succeed(Settings.ServerSettingsService, settings),
    ProcessRunner.layer,
  );
  const layer = Replicas.layer.pipe(Layer.provide(dependencies), Layer.provide(NodeServices.layer));
  const use = <A, E>(
    body: (service: Replicas.ThreadReplicaService["Service"]) => Effect.Effect<A, E>,
  ) => Replicas.ThreadReplicaService.pipe(Effect.flatMap(body), Effect.provide(layer));
  const capture = use((service) => service.capture({ threadId: sourceId, runId }, authorize)).pipe(
    Effect.map((result) => {
      assert.strictEqual(result.status, "captured");
      if (result.status !== "captured") throw new Error("capture failed");
      return result.replica;
    }),
  );
  return {
    settings,
    setPressureBlocked: (value: boolean) => {
      pressureBlocked = value;
    },
    captureCheckpoint,
    restoreLocal,
    ref,
    setSource: (patch: Partial<OrchestrationV2ThreadProjection>) => {
      projection = { ...projection, ...patch };
    },
    fs,
    path,
    root,
    source,
    destination,
    head,
    commit,
    git,
    launches,
    stored,
    projection,
    use,
    capture,
    setFailure: (value: typeof failAt) => {
      failAt = value;
    },
    setRepo: (value: string) =>
      git(destination, "remote", "set-url", "origin", `https://${value}.git`),
  };
});
const layers = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

export {
  sourceId,
  runId,
  projectId,
  encodeCheckpoint,
  decodeCheckpoint,
  authorize,
  fixture,
  layers,
};
