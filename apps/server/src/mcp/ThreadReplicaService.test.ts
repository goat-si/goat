// @effect-diagnostics nodeBuiltinImport:off - non-secret random fixture bytes exercise the compressed bundle cap.
import * as PressureNudger from "../fleet/pressure/PressureNudger.ts";
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationV2CheckpointJson,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  EnvironmentId,
  EventId,
  type OrchestrationV2Checkpoint,
  ProjectId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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
    checkpoints: [decodeCheckpoint(JSON.parse(JSON.stringify(encodeCheckpoint(checkpoint))))],
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
          checkpoints: [decodeCheckpoint(JSON.parse(JSON.stringify(encodeCheckpoint(produced))))],
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
          : Effect.sync(
              () =>
                ({
                  runs: stored.get(id)?.hasRun
                    ? [
                        {
                          id: RunId.make("recovered-run"),
                          userMessageId: stored.get(id)!.input.initialMessage!.messageId,
                        },
                      ]
                    : [],
                }) as never,
            ),
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
          launches.push(input);
          if (failAt !== "before_thread")
            stored.set(input.threadId!, { input, hasRun: failAt !== "after_thread" });
          if (failAt !== "none")
            return yield* new Launches.ThreadLaunchError({
              operation: "dispatch-message",
              commandId: input.commandId,
              projectId,
              cause: "response lost",
            });
          return {
            threadId: input.threadId!,
            resumed: false,
            projection: {
              runs: [
                { id: RunId.make("recovered-run"), userMessageId: input.initialMessage!.messageId },
              ],
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

describe("ThreadReplicaService", () => {
  it.live("refuses checkpoint operations while permission profiles are enabled", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      yield* f.settings.updateSettings({ goatclaw: { enabled: true } });
      const before = yield* f.settings.getSettings;
      const outcomes = yield* f.use((service) =>
        Effect.all([
          service.capture({ threadId: sourceId, runId }, authorize).pipe(Effect.result),
          service
            .restore({ operationId: "profile-blocked", projectId, replica }, authorize)
            .pipe(Effect.result),
          service
            .configureHost({ host: "box", checkpointReplication: "on" }, authorize)
            .pipe(Effect.result),
        ]),
      );
      assert.isTrue(outcomes.every((result) => result._tag === "Failure"));
      assert.strictEqual(f.launches.length, 0);
      assert.deepStrictEqual((yield* f.settings.getSettings).fleet, before.fleet);
      assert.isFalse(yield* f.fs.exists(f.path.join(f.root, "userdata", "thread-recovery")));
    }).pipe(Effect.provide(layers)),
  );

  it.live("blocks new recovery under pressure but permits a recorded launch to reconcile", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      const input = { operationId: "pressure-recovery", projectId, replica };
      f.setPressureBlocked(true);
      const refused = yield* f.use((service) =>
        service.restore(input, authorize).pipe(Effect.result),
      );
      assert.strictEqual(refused._tag, "Failure");
      if (refused._tag === "Failure") assert.strictEqual(refused.failure.code, "host_pressure");
      assert.strictEqual(f.launches.length, 0);
      assert.isFalse(yield* f.fs.exists(f.path.join(f.root, "userdata", "thread-recovery")));
      f.setPressureBlocked(false);
      const launched = yield* f.use((service) => service.restore(input, authorize));
      assert.strictEqual(launched.status, "launched");
      f.setPressureBlocked(true);
      const replay = yield* f.use((service) => service.restore(input, authorize));
      assert.deepStrictEqual(replay, launched);
      assert.strictEqual(f.launches.length, 1);
      const digest = yield* Replicas.replicaRestoreDigest(input);
      const reconciled = yield* f.use((service) =>
        service.reconcile({ operationId: input.operationId, requestDigest: digest }, authorize),
      );
      assert.deepStrictEqual(reconciled, launched);
    }).pipe(Effect.provide(layers)),
  );

  it.live.each(["older", "arbitrary"] as const)(
    "rejects a ready checkpoint ref forged to an %s commit",
    (kind) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const recorded = yield* Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const sql = yield* SqlClient.SqlClient;
          const checkpoint = f.projection.checkpoints[0]!;
          yield* store.apply({
            id: EventId.make("checkpoint-event"),
            type: "checkpoint.captured",
            threadId: sourceId,
            occurredAt: checkpoint.capturedAt,
            payload: checkpoint,
          });
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id = ${checkpoint.id}`;
          return decodeCheckpoint(JSON.parse(rows[0]!.payload_json));
        }).pipe(
          Effect.provide(
            ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
          ),
        );
        f.setSource({ checkpoints: [recorded] });
        const parent = yield* f.git(
          f.source,
          "rev-parse",
          kind === "older" ? `${f.head}^` : f.head,
        );
        const tree = yield* f.git(f.source, "rev-parse", `${parent}^{tree}`);
        const forged = yield* f.git(
          f.source,
          "commit-tree",
          tree,
          "-p",
          parent,
          "-m",
          "forged\n\nGoat-Checkpoint-Completeness: complete-v1",
        );
        yield* f.git(f.source, "update-ref", f.ref, forged);
        const result = yield* f.use((service) =>
          service.capture({ threadId: sourceId, runId }, authorize),
        );
        assert.deepStrictEqual(result, {
          status: "skipped",
          reason: "checkpoint_identity_mismatch",
        });
        assert.deepStrictEqual(recorded.replicationEvidence, {
          commitOid: f.commit,
          complete: true,
        });
        assert.strictEqual(f.launches.length, 0);
      }).pipe(Effect.provide(layers)),
  );

  it.live(
    "legacy checkpoint records remain locally ready but cannot replicate without producer evidence",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const legacy = JSON.parse(JSON.stringify(encodeCheckpoint(f.projection.checkpoints[0]!)));
        delete legacy.replicationEvidence;
        const checkpoint = decodeCheckpoint(legacy);
        assert.strictEqual(checkpoint.status, "ready");
        f.setSource({ checkpoints: [checkpoint] });
        assert.deepStrictEqual(
          yield* f.use((service) => service.capture({ threadId: sourceId, runId }, authorize)),
          { status: "skipped", reason: "incomplete_checkpoint" },
        );
        yield* f.restoreLocal(checkpoint);
        assert.strictEqual(
          yield* f.fs.readFileString(f.path.join(f.source, "tracked")),
          "captured dirty\n",
        );
      }).pipe(Effect.provide(layers)),
  );

  it.live(
    "ordinary producer preserves a force-added ignored file and its dirty disk contents",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(f.path.join(f.source, ".gitignore"), "added.txt\n");
        yield* f.fs.writeFileString(f.path.join(f.source, "added.txt"), "staged\n");
        yield* f.git(f.source, "add", "-f", "added.txt");
        yield* f.fs.writeFileString(f.path.join(f.source, "added.txt"), "dirty ignored content\n");
        const index = yield* f.fs.readFile(f.path.join(f.source, ".git", "index"));
        yield* f.captureCheckpoint;
        const replica = yield* f.capture;
        assert.strictEqual(
          yield* f.git(f.source, "show", `${replica.commitOid}:added.txt`),
          "dirty ignored content",
        );
        assert.deepStrictEqual(yield* f.fs.readFile(f.path.join(f.source, ".git", "index")), index);
        const restored = yield* f.use((service) =>
          service.restore({ operationId: "ignored-file", projectId, replica }, authorize),
        );
        assert.strictEqual(restored.status, "launched");
        const workspace = f.launches[0]!.workspaceStrategy;
        assert.strictEqual(workspace.type, "existing_worktree");
        if (workspace.type === "existing_worktree")
          assert.strictEqual(
            yield* f.fs.readFileString(f.path.join(workspace.worktreePath, "added.txt")),
            "dirty ignored content\n",
          );
      }).pipe(Effect.provide(layers)),
  );

  it.live.each([false, true])(
    "export bypasses reference-transaction hooks even on bundle failure=%s",
    (failBundle) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const hooks = f.path.join(f.root, "hooks");
        const marker = f.path.join(f.root, "reference-hook-ran");
        yield* f.fs.makeDirectory(hooks);
        yield* f.fs.writeFileString(
          f.path.join(hooks, "reference-transaction"),
          `#!/bin/sh\nprintf ran >> '${marker}'\nexit 0\n`,
        );
        yield* f.fs.chmod(f.path.join(hooks, "reference-transaction"), 0o700);
        yield* f.git(f.source, "config", "core.hooksPath", hooks);
        if (failBundle) yield* f.git(f.source, "config", "pack.window", "invalid");
        const refs = yield* f.git(f.source, "show-ref");
        const config = yield* f.fs.readFile(f.path.join(f.source, ".git", "config"));
        const index = yield* f.fs.readFile(f.path.join(f.source, ".git", "index"));
        const result = yield* f
          .use((service) => service.capture({ threadId: sourceId, runId }, authorize))
          .pipe(Effect.result);
        assert.strictEqual(result._tag, failBundle ? "Failure" : "Success");
        assert.isFalse(yield* f.fs.exists(marker));
        assert.strictEqual(yield* f.git(f.source, "show-ref"), refs);
        assert.deepStrictEqual(
          yield* f.fs.readFile(f.path.join(f.source, ".git", "config")),
          config,
        );
        assert.deepStrictEqual(yield* f.fs.readFile(f.path.join(f.source, ".git", "index")), index);
        assert.strictEqual(
          yield* f.fs.readFileString(f.path.join(f.source, "tracked")),
          "later edit\n",
        );
      }).pipe(Effect.provide(layers)),
  );

  it.live.each(["unborn", "dirty-submodule"] as const)(
    "refuses incomplete actual checkpoint with %s without exporting partial recovery",
    (kind) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const nested = f.path.join(f.source, "nested");
        yield* f.fs.makeDirectory(nested);
        yield* f.git(nested, "init", "-q");
        yield* f.fs.writeFileString(f.path.join(nested, "private.txt"), "nested original\n");
        if (kind === "dirty-submodule") {
          yield* f.git(nested, "add", ".");
          yield* f.git(nested, "commit", "-qm", "nested base");
          yield* f.git(f.source, "add", "nested");
          yield* f.git(f.source, "commit", "-qm", "gitlink");
          yield* f.fs.writeFileString(f.path.join(nested, "private.txt"), "nested dirty\n");
        }
        const head = yield* f.git(f.source, "rev-parse", "HEAD");
        const index = yield* f.fs.readFile(f.path.join(f.source, ".git", "index"));
        yield* f.captureCheckpoint;
        const result = yield* f.use((service) =>
          service.capture({ threadId: sourceId, runId }, authorize),
        );
        assert.deepStrictEqual(result, { status: "skipped", reason: "incomplete_checkpoint" });
        assert.strictEqual(yield* f.git(f.source, "rev-parse", "HEAD"), head);
        assert.deepStrictEqual(yield* f.fs.readFile(f.path.join(f.source, ".git", "index")), index);
        assert.strictEqual(
          yield* f.fs.readFileString(f.path.join(nested, "private.txt")),
          kind === "unborn" ? "nested original\n" : "nested dirty\n",
        );
        assert.strictEqual(
          yield* f.git(f.source, "for-each-ref", "--format=%(refname)", "refs/goat/replicas/"),
          "",
        );
        assert.strictEqual(f.launches.length, 0);
      }).pipe(Effect.provide(layers)),
  );

  it.live(
    "refuses an old checkpoint without completeness proof and does not run live filters or hooks",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = yield* f.git(f.source, "rev-parse", f.ref);
        const tree = yield* f.git(f.source, "rev-parse", `${f.ref}^{tree}`);
        const old = yield* f.git(
          f.source,
          "commit-tree",
          tree,
          "-p",
          f.head,
          "-m",
          "legacy checkpoint",
        );
        yield* f.git(f.source, "update-ref", f.ref, old);
        assert.deepStrictEqual(
          yield* f.use((service) => service.capture({ threadId: sourceId, runId }, authorize)),
          { status: "skipped", reason: "checkpoint_identity_mismatch" },
        );
        yield* f.git(f.source, "update-ref", f.ref, original);
        yield* f.fs.writeFileString(f.path.join(f.source, ".gitattributes"), "* filter=tripwire\n");
        yield* f.git(f.source, "config", "filter.tripwire.clean", "touch filter-executed; cat");
        yield* f.fs.writeFileString(
          f.path.join(f.source, ".git", "hooks", "pre-commit"),
          "#!/bin/sh\ntouch hook-executed\n",
        );
        yield* f.fs.chmod(f.path.join(f.source, ".git", "hooks", "pre-commit"), 0o700);
        yield* f.capture;
        assert.isFalse(yield* f.fs.exists(f.path.join(f.source, "filter-executed")));
        assert.isFalse(yield* f.fs.exists(f.path.join(f.source, "hook-executed")));
        assert.strictEqual(
          yield* f.fs.readFileString(f.path.join(f.source, "tracked")),
          "later edit\n",
        );
        assert.strictEqual(yield* f.git(f.source, "rev-parse", "HEAD"), f.head);
      }).pipe(Effect.provide(layers)),
  );

  it.live("preserves a source plan-mode ceiling when a default-mode caller recovers it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setSource({ thread: { ...f.projection.thread, interactionMode: "plan" } });
      const replica = yield* f.capture;
      assert.strictEqual(replica.interactionMode, "plan");
      assert.strictEqual(
        (yield* f.use((service) =>
          service.restore({ operationId: "plan-source", projectId, replica }, authorize),
        )).status,
        "launched",
      );
      assert.strictEqual(f.launches[0]?.interactionMode, "plan");
    }).pipe(Effect.provide(layers)),
  );

  it.live.each(["revoked", "profiles-enabled"] as const)(
    "rechecks %s after persisting launch intent and sends no launch",
    (reason) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const replica = yield* f.capture;
        let checks = 0;
        const revokeBeforeLaunch = Effect.suspend(() =>
          ++checks < 4
            ? authorize
            : reason === "profiles-enabled"
              ? f.settings
                  .updateSettings({ goatclaw: { enabled: true } })
                  .pipe(Effect.orDie, Effect.andThen(authorize))
              : Effect.fail(
                  new OrchestratorMcpFailure({ code: "capability_denied", message: "revoked" }),
                ),
        );
        const result = yield* f.use((service) =>
          service.restore(
            { operationId: "revoked-launch", projectId, replica },
            revokeBeforeLaunch,
          ),
        );
        assert.strictEqual(result.status, "refused");
        assert.strictEqual(result.reason, "authorization_changed");
        assert.strictEqual(f.launches.length, 0);
      }).pipe(Effect.provide(layers)),
  );

  it.live.each(["missing", "cloud", "uninstalled", "signedout"] as const)(
    "refuses %s providers before creating a recovery thread",
    (instance) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const replica = yield* f.capture;
        const result = yield* f.use((service) =>
          service.restore(
            {
              operationId: "provider-refusal",
              projectId,
              replica,
              modelSelection: { instanceId: ProviderInstanceId.make(instance), model: "test" },
            },
            authorize,
          ),
        );
        assert.strictEqual(result.status, "refused");
        assert.strictEqual(f.launches.length, 0);
      }).pipe(Effect.provide(layers)),
  );

  it.live("durably refuses an invalid destination and accepts a corrected new operation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      const bad = {
        operationId: "bad-destination",
        projectId: ProjectId.make("missing-project"),
        replica,
      };
      const rejected = yield* f.use((service) => service.restore(bad, authorize));
      assert.strictEqual(rejected.status, "refused");
      const corrected = yield* f.use((service) =>
        service.restore({ operationId: "corrected", projectId, replica }, authorize),
      );
      assert.strictEqual(corrected.status, "launched");
      const delayedOld = yield* f.use((service) => service.restore(bad, authorize));
      assert.strictEqual(delayedOld.status, "refused");
      assert.strictEqual(f.launches.length, 1);
    }).pipe(Effect.provide(layers)),
  );

  it.live("reconciles a persisted run after replica expiry without payload contents", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      const request = { operationId: "expired-response", projectId, replica };
      f.setFailure("after_run");
      assert.strictEqual(
        (yield* f.use((service) => service.restore(request, authorize))).status,
        "launch_unknown",
      );
      const requestDigest = yield* Replicas.replicaRestoreDigest(request);
      const clock = yield* Clock.Clock;
      const future = Date.parse(replica.capturedAt) + 8 * 24 * 60 * 60_000;
      const result = yield* f
        .use((service) =>
          service.reconcile({ operationId: request.operationId, requestDigest }, authorize),
        )
        .pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: Effect.succeed(future),
            currentTimeMillisUnsafe: () => future,
            currentTimeNanos: Effect.succeed(BigInt(future) * 1_000_000n),
            currentTimeNanosUnsafe: () => BigInt(future) * 1_000_000n,
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: (duration) => clock.sleep(duration),
          }),
        );
      assert.strictEqual(result.status, "launched");
      assert.strictEqual(result.runId, "recovered-run");
      assert.strictEqual(f.launches.length, 1);
    }).pipe(Effect.provide(layers)),
  );

  it.live("reconciliation fences a delayed request before any launch was sent", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      const request = { operationId: "not-sent", projectId, replica };
      const requestDigest = yield* Replicas.replicaRestoreDigest(request);
      const stopped = yield* f.use((service) =>
        service.reconcile({ operationId: request.operationId, requestDigest }, authorize),
      );
      assert.strictEqual(stopped.status, "refused");
      assert.strictEqual(
        (yield* f.use((service) => service.restore(request, authorize))).status,
        "refused",
      );
      assert.strictEqual(f.launches.length, 0);
    }).pipe(Effect.provide(layers)),
  );

  it.live("requires a completed ready checkpoint and real conversation content", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setSource({ runs: f.projection.runs.map((run) => ({ ...run, status: "running" })) });
      assert.deepStrictEqual(
        yield* f.use((service) => service.capture({ threadId: sourceId, runId }, authorize)),
        { status: "skipped", reason: "checkpoint_not_ready" },
      );
      f.setSource({
        runs: f.projection.runs,
        checkpoints: f.projection.checkpoints.map((checkpoint) => ({
          ...checkpoint,
          status: "error",
        })),
      });
      assert.deepStrictEqual(
        yield* f.use((service) => service.capture({ threadId: sourceId, runId }, authorize)),
        { status: "skipped", reason: "checkpoint_not_ready" },
      );
      f.setSource({ checkpoints: f.projection.checkpoints, visibleTurnItems: [] });
      assert.deepStrictEqual(
        yield* f.use((service) => service.capture({ threadId: sourceId, runId }, authorize)),
        { status: "skipped", reason: "context_unavailable" },
      );
    }).pipe(Effect.provide(layers)),
  );

  it.live("changes only host replication policy and reauthorizes inside the settings lock", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.use((service) =>
        service.configureHost({ host: "box", checkpointReplication: "on" }, authorize),
      );
      assert.deepStrictEqual((yield* f.settings.getSettings).fleet.hosts?.box, {
        maxThreads: 3,
        allowGoals: false,
        checkpointReplication: "on",
      });
      let checks = 0;
      const revoked = Effect.suspend(() =>
        ++checks === 1
          ? authorize
          : Effect.fail(
              new OrchestratorMcpFailure({ code: "capability_denied", message: "revoked" }),
            ),
      );
      const refused = yield* f
        .use((service) =>
          service.configureHost({ host: "box", checkpointReplication: "off" }, revoked),
        )
        .pipe(Effect.result);
      assert.strictEqual(refused._tag, "Failure");
      assert.strictEqual(
        (yield* f.settings.getSettings).fleet.hosts?.box?.checkpointReplication,
        "on",
      );
    }).pipe(Effect.provide(layers)),
  );

  it.live("rejects oversized added files and oversized tracked snapshots without launching", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFile(
        f.path.join(f.source, "too-big-new"),
        new Uint8Array(2 * 1024 * 1024 + 1),
      );
      yield* f.git(f.source, "add", ".");
      yield* f.captureCheckpoint;
      const excluded = yield* f.use((service) =>
        service.capture({ threadId: sourceId, runId }, authorize),
      );
      assert.deepStrictEqual(excluded, { status: "skipped", reason: "excluded_files" });
      yield* f.git(f.source, "rm", "-f", "too-big-new");
      yield* f.fs.writeFile(
        f.path.join(f.source, "tracked"),
        NodeCrypto.randomBytes(9 * 1024 * 1024),
      );
      yield* f.git(f.source, "add", ".");
      yield* f.captureCheckpoint;
      const oversized = yield* f.use((service) =>
        service.capture({ threadId: sourceId, runId }, authorize),
      );
      assert.deepStrictEqual(oversized, { status: "skipped", reason: "too_large" });
      assert.strictEqual(f.launches.length, 0);
    }).pipe(Effect.provide(layers)),
  );

  it.live("rejects a forged bundle head and context digest", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      const invalidHead = yield* f
        .use((service) =>
          service.restore(
            {
              operationId: "forged-head",
              projectId,
              replica: { ...replica, headOid: "0".repeat(40) },
            },
            authorize,
          ),
        )
        .pipe(Effect.result);
      assert.strictEqual(invalidHead._tag, "Success");
      if (invalidHead._tag === "Success") assert.strictEqual(invalidHead.success.status, "refused");
      const invalidContext = yield* f
        .use((service) =>
          service.restore(
            {
              operationId: "forged-context",
              projectId,
              replica: { ...replica, context: "changed context" },
            },
            authorize,
          ),
        )
        .pipe(Effect.result);
      assert.strictEqual(invalidContext._tag, "Success");
      if (invalidContext._tag === "Success")
        assert.strictEqual(invalidContext.success.status, "refused");
      assert.strictEqual(f.launches.length, 0);
    }).pipe(Effect.provide(layers)),
  );

  it.live("rejects corrupt, stale, mismatched and unauthorized recovery before launch", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      const request = { operationId: "negative", projectId, replica };
      const corrupt = yield* f
        .use((service) =>
          service.restore(
            { ...request, operationId: "corrupt", replica: { ...replica, sha256: "0".repeat(64) } },
            authorize,
          ),
        )
        .pipe(Effect.result);
      assert.strictEqual(corrupt._tag, "Success");
      if (corrupt._tag === "Success") assert.strictEqual(corrupt.success.status, "refused");
      const stale = yield* f
        .use((service) =>
          service.restore(
            {
              ...request,
              operationId: "stale",
              replica: { ...replica, capturedAt: "2000-01-01T00:00:00.000Z" },
            },
            authorize,
          ),
        )
        .pipe(Effect.result);
      assert.strictEqual(stale._tag, "Success");
      if (stale._tag === "Success") assert.strictEqual(stale.success.status, "refused");
      yield* f.setRepo("github.com/example/other");
      const mismatched = yield* f
        .use((service) => service.restore(request, authorize))
        .pipe(Effect.result);
      assert.strictEqual(mismatched._tag, "Success");
      if (mismatched._tag === "Success") assert.strictEqual(mismatched.success.status, "refused");
      yield* f.setRepo(replica.repositoryKey);
      const denied = yield* f
        .use((service) =>
          service.restore(
            request,
            Effect.succeed({ runtimeMode: "auto", interactionMode: "default" }),
          ),
        )
        .pipe(Effect.result);
      assert.strictEqual(denied._tag, "Failure");
      assert.strictEqual(f.launches.length, 0);
    }).pipe(Effect.provide(layers)),
  );

  it.live("restores immutable unpushed and dirty state in isolation with the source removed", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const replica = yield* f.capture;
      assert.notInclude(replica.context, "FUTURE INPUT");
      assert.strictEqual(
        yield* f.git(f.source, "for-each-ref", "--format=%(refname)", "refs/goat/replicas/"),
        "",
      );
      yield* f.fs.remove(f.source, { recursive: true });
      const result = yield* f.use((service) =>
        service.restore({ operationId: "offline", projectId, replica }, authorize),
      );
      assert.strictEqual(result.status, "launched");
      const strategy = f.launches[0]!.workspaceStrategy;
      assert.strictEqual(strategy.type, "existing_worktree");
      if (strategy.type !== "existing_worktree") return;
      assert.strictEqual(yield* f.git(strategy.worktreePath, "rev-parse", "HEAD"), f.head);
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(strategy.worktreePath, "tracked")),
        "captured dirty\n",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(strategy.worktreePath, "new-file")),
        "captured new\n",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(strategy.worktreePath, "unpushed")),
        "unpushed commit\n",
      );
      assert.include(yield* f.git(strategy.worktreePath, "status", "--porcelain"), " M tracked");
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.destination, "tracked")),
        "base\n",
      );
      assert.strictEqual(f.launches[0]!.initialMessage!.memoryGrantCeiling, "none");
    }).pipe(Effect.provide(layers)),
  );

  it.live.each(["before_thread", "after_thread", "after_run"] as const)(
    "reconciles %s after service restart without repeating a possibly sent launch",
    (stage) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const replica = yield* f.capture;
        f.setFailure(stage);
        const input = { operationId: "restart", projectId, replica };
        const first = yield* f.use((service) => service.restore(input, authorize));
        assert.strictEqual(first.status, "launch_unknown");
        f.setFailure("none");
        const retried = yield* f.use((service) => service.restore(input, authorize));
        assert.strictEqual(retried.status, stage === "after_run" ? "launched" : "launch_unknown");
        assert.strictEqual(retried.runId, stage === "after_run" ? "recovered-run" : null);
        assert.strictEqual(f.launches.length, 1);
      }).pipe(Effect.provide(layers)),
  );
});
