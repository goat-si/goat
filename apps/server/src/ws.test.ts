import * as MemoryService from "./memory/MemoryService.ts";
import { makeMemoryImportHandlers } from "./ws.ts";
import * as Schema from "effect/Schema";
import * as RpcTest from "effect/rpc/RpcTest";
import {
  WsRpcGroup,
  WS_METHODS,
  SshWorkspaceLaunchInput,
  SshWorkspaceLaunchResult,
  SshWorkspaceError,
  AuthSourceControlWriteScope,
  AuthOrchestrationOperateScope,
  type SshWorkspaceFetchBackInput,
} from "@goat/contracts";
import * as SshWorkspaceSync from "./sshRemote/SshWorkspaceSync.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import { assert, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  withLateEditorConfig,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

// Only the fields the late-editor fold reads or rewrites.
const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        // Holds the late snapshot until the settings change has gone out.
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("sends no late snapshot when the scan matches the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["vscode"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["vscode"]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
    ).pipe(Stream.runCollect);

    assert.equal(events.length, 0);
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

// The real launcher on Windows over a filesystem whose probes park until
// released, like a host too busy to finish discovery inside the snapshot timeout.
const makeParkedWindowsLauncher = Effect.gen(function* () {
  const parkedProbes = yield* Queue.unbounded<void>();
  const release = yield* Deferred.make<void>();
  const launcher = yield* ExternalLauncher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Queue.offer(parkedProbes, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ type: "File" } as FileSystem.File.Info),
            ),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
        ),
      ),
    ),
  );
  const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-late-editors-test", PATHEXT: ".EXE" },
          }),
        ),
      ),
    );
  return {
    editors: {
      resolveAvailableEditors: () => onWindows(launcher.resolveAvailableEditors()),
      resolveFileManagerRevealKind: () => onWindows(launcher.resolveFileManagerRevealKind()),
    },
    probeParked: Queue.take(parkedProbes),
    releaseProbes: Deferred.succeed(release, undefined),
  };
});

it.effect("recovers editors after a real scan outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const snapshotFiber = yield* resolveAvailableEditorsForConfig(
      editors.resolveAvailableEditors(),
    ).pipe(Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(5));
    const snapshotEditors = yield* Fiber.join(snapshotFiber);
    assert.deepEqual(snapshotEditors, []);

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: snapshotEditors }),
      Stream.empty,
      editors,
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.availableEditors.includes("vscode"), true);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovers a reveal kind whose real probe outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    // The snapshot's bounded probe timed out: file manager, but no reveal kind.
    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: editors.resolveFileManagerRevealKind,
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(6));
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

it.effect("SSH workspace handlers delegate once and preserve typed errors", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          import("effect/rpc/RpcGroup").Rpcs<typeof WsRpcGroup>["_tag"],
          typeof WS_METHODS.sshWorkspaceLaunch | typeof WS_METHODS.sshWorkspaceFetchBack
        > => tag !== WS_METHODS.sshWorkspaceLaunch && tag !== WS_METHODS.sshWorkspaceFetchBack,
      ),
    );
    const launchInput = yield* Schema.decodeUnknownEffect(SshWorkspaceLaunchInput)({
      sourceProjectId: "source",
      destination: {
        connectionId: "saved",
        expectedEnvironmentId: "remote",
        target: { alias: "box", hostname: "box", username: null, port: null },
      },
      title: "Work",
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      initialMessage: { text: "Implement" },
    });
    const launchOutput = yield* Schema.decodeUnknownEffect(SshWorkspaceLaunchResult)({
      operationId: "12345678",
      snapshotRef: "refs/goat/snapshots/12345678",
      snapshotOid: "a".repeat(40),
      remoteEnvironmentId: "remote",
      remoteProjectId: "rp",
      remoteThreadId: "rt",
      remoteRepoPath: "/home/test/.goat/repos/repo-12345678",
      branch: "goat/ssh/12345678",
    });
    const fetchInput = {
      target: launchInput.destination.target,
      remoteWorkspaceRoot: launchOutput.remoteRepoPath,
      branch: launchOutput.branch,
    };
    const fetchOutput = {
      sourceProjectId: launchInput.sourceProjectId,
      localWorkspaceRoot: "/repo",
      localRef: "refs/remotes/goat-ssh/box/goat/ssh/12345678",
      commitOid: "a".repeat(40),
      remoteBranch: fetchInput.branch,
    };
    const launches: SshWorkspaceLaunchInput[] = [];
    const fetches: SshWorkspaceFetchBackInput[] = [];
    let failure: SshWorkspaceError | undefined;
    const sync = Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({
      launch: (input) =>
        Effect.suspend(() => {
          launches.push(input);
          return failure ? Effect.fail(failure) : Effect.succeed(launchOutput);
        }),
      fetchBack: (input) =>
        Effect.suspend(() => {
          fetches.push(input);
          return failure ? Effect.fail(failure) : Effect.succeed(fetchOutput);
        }),
    });
    const handlers = group
      .toLayer(
        Effect.gen(function* () {
          const service = yield* SshWorkspaceSync.SshWorkspaceSync;
          return {
            [WS_METHODS.sshWorkspaceLaunch]: (input) => service.launch(input),
            [WS_METHODS.sshWorkspaceFetchBack]: (input) => service.fetchBack(input),
          };
        }),
      )
      .pipe(Layer.provide(sync));
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]),
        ),
      ),
    );
    assert.deepEqual(yield* client[WS_METHODS.sshWorkspaceLaunch](launchInput), launchOutput);
    assert.deepEqual(yield* client[WS_METHODS.sshWorkspaceFetchBack](fetchInput), fetchOutput);
    assert.deepEqual(launches, [launchInput]);
    assert.deepEqual(fetches, [fetchInput]);
    failure = new SshWorkspaceError({
      stage: "launch",
      code: "launch_uncertain",
      host: "box",
      operationId: "12345678",
    });
    assert.deepEqual(
      yield* client[WS_METHODS.sshWorkspaceLaunch](launchInput).pipe(Effect.flip),
      failure,
    );
    failure = new SshWorkspaceError({ stage: "fetch", code: "fetch_failed", host: "box" });
    assert.deepEqual(
      yield* client[WS_METHODS.sshWorkspaceFetchBack](fetchInput).pipe(Effect.flip),
      failure,
    );
    assert.lengthOf(launches, 2);
    assert.lengthOf(fetches, 2);
  }).pipe(Effect.scoped),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("an unavailable import runtime rejects before invoking the service facade", () =>
  Effect.gen(function* () {
    const handlers = yield* makeMemoryImportHandlers(
      Effect.succeed(["memory:write", "filesystem:read"]),
      ["memory:write", "filesystem:read"],
    ).pipe(
      Effect.provide(
        Layer.mock(MemoryService.MemoryService)({
          importPorts: {} as MemoryService.MemoryService["Service"]["importPorts"],
          importProvider: () => Effect.die("unavailable runtime must not call facade"),
        }),
      ),
    );
    const result = yield* handlers[WS_METHODS.memoryImportProvider]({
      action: "discover",
      memorySpaceId:
        "00000000-0000-4000-8000-000000000001" as import("@goat/contracts").MemorySpaceId,
      format: "codex",
    }).pipe(Effect.flip);
    assert.equal(result._tag, "MemoryRpcError");
    if (result._tag === "MemoryRpcError") assert.equal(result.code, "unavailable");
  }),
);
