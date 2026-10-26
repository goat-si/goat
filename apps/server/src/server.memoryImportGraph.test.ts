import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as RpcTest from "effect/rpc/RpcTest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- independent synthetic source hash/mtime oracle.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the git path must be absolute for the host.
import * as NodePath from "node:path";
import * as Logger from "effect/Logger";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- independent synthetic source hash oracle.
import * as NodeCrypto from "node:crypto";
import * as Config from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Environment from "./environment/ServerEnvironment.ts";
import * as Repository from "./project/RepositoryIdentityResolver.ts";
import * as Store from "./memory/MemoryStore.ts";
import * as Quota from "./memory/MemoryQuotaService.ts";
import * as Service from "./memory/MemoryService.ts";
import * as Sync from "./memory/MemorySyncService.ts";
import * as Hub from "./memory/MemoryHubService.ts";
import * as Generation from "./textGeneration/TextGeneration.ts";
import * as Registry from "./provider/ProviderInstanceRegistry.ts";
import * as Authorization from "./auth/RpcAuthorization.ts";
import {
  RpcInstrumentation,
  rpcInstrumentationLayer as instrumentation,
} from "./observability/RpcInstrumentation.ts";
import { makeMemoryImportHandlers } from "./ws.ts";
import {
  ProviderMemoryImportRuntime,
  provenanceImportFormat,
} from "./memory/imports/MemoryImportTypes.ts";
import {
  buildMemoryImportFixture,
  captureMemoryImportInventory,
  hostGit,
  type MemoryImportFixtureProfile,
} from "./memory/imports/MemoryImportFixtures.fixture.ts";
import {
  layerMemoryImport,
  layerMemoryHubServices,
  layerMemoryHubRoutes,
  layerMemorySourceReadService,
  layerMemorySourceReadBinding,
  layerMemorySyncRuntime,
  MemorySourceReadBinding,
} from "./server.ts";

// Actual filesystem semantics must not depend on the app's platform override.
// oxlint-disable-next-line goat/no-global-process-runtime -- synthetic filesystem permission oracle.
const posixPermissions = NodeOS.platform() !== "win32";
// The reader rejects a path that is not already normalized and absolute for the host; Windows
// normalizes "/usr/bin/git" to a backslash path without a drive.
const gitExecutable = NodePath.resolve("/usr/bin/git");

const grants = ["memory:write", "filesystem:read"] as const;
const id = () => M.MemoryOperationId.make(NodeCrypto.randomUUID());
// This constructs the application's layers, including durable SQL, settings, identity,
// real Sync/Hub and the same scoped reader/factory used by server.ts. Only unused
// provider generation/registry boundaries are doubles; import has no mocked ports.
const graph = (
  config: Parameters<typeof layerMemoryImport>[0] = undefined,
  scopes?: Effect.Effect<readonly M.AuthEnvironmentScope[]>,
  afterCommit?: Effect.Effect<void>,
  syntheticHome?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home =
      syntheticHome ?? (yield* fs.makeTempDirectoryScoped({ prefix: "wp5-import-graph-" }));
    const memo = yield* Layer.makeMemoMap;
    const scope = yield* Scope.Scope;
    const settings = Settings.layer.pipe(
      Layer.provide(Environment.layerIdentity),
      Layer.provideMerge(Secrets.layer),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(Config.layerTest(home, home)),
    );
    const core = layerMemorySourceReadService.pipe(
      Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
      Layer.provideMerge(layerMemorySourceReadBinding),
      Layer.provideMerge(Environment.layerIdentity),
      Layer.provide(Repository.layer),
    );
    const services = layerMemoryHubServices.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(settings),
    );
    const base = yield* Layer.buildWithMemoMap(
      services.pipe(Layer.provideMerge(NodeServices.layer)),
      memo,
      scope,
    );
    const sync = Sync.layer.pipe(
      Layer.provideMerge(layerMemorySyncRuntime),
      Layer.provide(Layer.mock(Generation.TextGeneration)({})),
      Layer.provide(
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
      ),
      Layer.provideMerge(Layer.succeedContext(base)),
      Layer.provide(FetchHttpClient.layer),
    );
    const observed = Layer.effect(
      Service.MemoryService,
      Effect.gen(function* () {
        const actual = yield* Service.MemoryService;
        return Service.MemoryService.of({
          ...actual,
          importPorts: {
            ...actual.importPorts,
            commit: (input, permit) =>
              actual.importPorts
                .commit(input, permit)
                .pipe(Effect.tap(() => afterCommit ?? Effect.void)),
          },
        });
      }),
    ).pipe(Layer.provideMerge(sync));
    const context = yield* Layer.buildWithMemoMap(
      layerMemoryImport(config).pipe(
        Layer.provideMerge(afterCommit ? observed : sync),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
      ),
      memo,
      scope,
    );
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideContext(context));
    const service = Context.get(context, Service.MemoryService);
    const memorySync = Context.get(context, Sync.MemorySyncService);
    yield* Context.get(context, MemorySourceReadBinding).bind(memorySync);
    const configured = yield* run(
      Hub.MemoryHubAdministrator.use((a) =>
        a.update(
          {
            requestId: id(),
            expectedVersion: 0,
            action: "configure",
            settings: { mode: "hub", memorySpaceId: null },
          },
          Effect.void,
        ),
      ),
    );
    assert.equal(configured.view.settings.mode, "hub");
    if (configured.view.settings.mode !== "hub") return yield* Effect.die("hub required");
    const space = configured.view.settings.memorySpaceId!;
    yield* memorySync.syncOnce;
    const routes = layerMemoryHubRoutes.pipe(
      HttpRouter.provideRequest(Layer.succeedContext(context)),
      Layer.provide(Layer.succeedContext(context)),
    );
    const descriptorContext = yield* Layer.buildWithMemoMap(
      Environment.layer.pipe(
        Layer.provideMerge(routes),
        Layer.provideMerge(Layer.succeedContext(context)),
        Layer.provide(HttpRouter.layer),
      ),
      memo,
      scope,
    );
    const descriptor = yield* Environment.ServerEnvironment.use((s) => s.getDescriptor).pipe(
      Effect.provideContext(descriptorContext),
    );
    const live = yield* Ref.make<readonly M.AuthEnvironmentScope[]>(grants);
    const group = M.WsMemoryImportRpcGroup.middleware(RpcInstrumentation);
    const handlers = group.toLayer(makeMemoryImportHandlers(scopes ?? Ref.get(live), grants));
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          handlers.pipe(Layer.provide(Layer.succeedContext(context))),
          instrumentation,
          Authorization.layer(grants),
        ),
      ),
    );
    return {
      run,
      service,
      space,
      descriptor,
      live,
      call: client[M.WS_METHODS.memoryImportProvider],
      tick: memorySync.syncOnce,
      context,
      stateDir: Context.get(context, Config.ServerConfig).stateDir,
    };
  });
const stamp = (root: string) => {
  const result: Record<string, { hash: string; mtime: string }> = {};
  const walk = (dir: string) => {
    for (const name of NodeFS.readdirSync(dir).sort()) {
      const path = `${dir}/${name}`;
      const stat = NodeFS.lstatSync(path, { bigint: true });
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        result[path.slice(root.length + 1)] = {
          hash: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
          mtime: String(stat.mtimeNs),
        };
    }
  };
  walk(root);
  return result;
};

const assembledImport = (profile: MemoryImportFixtureProfile) =>
  Effect.gen(function* () {
    const fixture = yield* buildMemoryImportFixture(profile);
    let reads = 0;
    const before = stamp(fixture.sourceRoot);
    const inventory = captureMemoryImportInventory(fixture.sourceRoot);
    const g = yield* graph({
      stateDir: fixture.stateDir,
      gitExecutable,
      roots: [
        {
          format: fixture.snapshot.format,
          rootSlot: "synthetic",
          path: fixture.trustedRoot,
        },
      ],
      onSourceRead: () => {
        reads++;
      },
    });
    assert.equal(g.descriptor.capabilities.memory?.protocolVersion, 1);
    assert.equal(g.descriptor.capabilities.memory?.importProvider, true);
    assert.equal(g.descriptor.capabilities.memoryHubProtocolVersion, 1);
    const discovered = yield* g.call({
      action: "discover",
      memorySpaceId: g.space,
      format: fixture.snapshot.format,
    });
    assert.equal(discovered.action, "discover");
    if (discovered.action !== "discover") return;
    assert.lengthOf(discovered.sources, 1);
    const sourceId = discovered.sources[0]!.sourceId;
    const preview = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
    if (preview.action !== "preview") return assert.fail("preview");
    const apply: M.MemoryImportProviderInput = {
      action: "apply",
      memorySpaceId: g.space,
      sourceId,
      sessionId: preview.sessionId,
      operationId: id(),
      items: preview.items.map((item) => ({
        sourceItemKey: item.sourceItemKey,
        sourceFingerprint: item.sourceFingerprint!,
        scope: { kind: "user" },
      })),
    };
    const applied = yield* g.call(apply);
    if (applied.action !== "apply") return assert.fail("apply");
    assert.equal(applied.receipt.state, "completed");
    assert.lengthOf(applied.receipt.items, 1);
    assert.equal(applied.receipt.items[0]!.outcome, "created");
    // Real hub admission and ACK settle the ordinary pending local import.
    yield* g.tick;
    const readCount = reads;
    const status = yield* g.call({
      action: "status",
      memorySpaceId: g.space,
      operationId: apply.operationId,
    });
    assert.equal(reads, readCount);
    if (status.action !== "status") return assert.fail("status");
    assert.equal(status.receipt.state, "completed");
    const memoryId = applied.receipt.items[0]!.memoryId!;
    const item = yield* g.service.read({ memorySpaceId: g.space, memoryId }, Effect.void);
    assert.equal(item.status, "active");
    if (item.status !== "active") return assert.fail("active memory");
    const sql = yield* g.run(Store.MemoryStore.use((s) => s.readImportLineage(g.space, memoryId)));
    assert.isTrue(
      sql.some(
        (row) =>
          row.kind === "sourceKey" &&
          row.sourceKey.sourceId === sourceId &&
          row.sourceKey.sourceItemKey === preview.items[0]!.sourceItemKey,
      ),
    );
    assert.equal(item.pendingSync, false);
    assert.deepInclude(item.revision.provenance.importSource, {
      sourceId,
      format: provenanceImportFormat(fixture.snapshot.format),
      sourceItemKey: preview.items[0]!.sourceItemKey,
      sourceFingerprint: preview.items[0]!.sourceFingerprint!,
    });
    const serialized = JSON.stringify(item);
    assert.include(serialized, sourceId);
    assert.include(serialized, preview.items[0]!.sourceItemKey);
    assert.include(serialized, fixture.snapshot.format);
    // Every action reuses the live compound permit, including source-free status.
    for (const missing of grants) {
      yield* Ref.set(
        g.live,
        grants.filter((scope) => scope !== missing),
      );
      for (const input of [
        { action: "discover", memorySpaceId: g.space, format: fixture.snapshot.format },
        { action: "preview", memorySpaceId: g.space, sourceId },
        apply,
        { action: "status", memorySpaceId: g.space, operationId: apply.operationId },
      ] as const) {
        assert.equal((yield* g.call(input).pipe(Effect.flip))._tag, "MemoryRpcError");
      }
    }
    yield* Ref.set(g.live, grants);
    if (fixture.snapshot.format === "codex") {
      const heads = [item.revision.revisionId];
      yield* g.service.forget(
        { memorySpaceId: g.space, memoryId, operationId: id(), expectedHeads: heads },
        Effect.void,
      );
      yield* g.tick;
      const retry = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
      if (retry.action !== "preview") return assert.fail("retry preview");
      assert.equal(retry.items[0]!.priorOutcome, "suppressed");
      const refused = yield* g.call({ ...apply, operationId: id(), sessionId: retry.sessionId });
      if (refused.action !== "apply") return assert.fail("retry apply");
      assert.equal(refused.receipt.items[0]!.outcome, "suppressed");
    }
    assert.deepEqual(stamp(fixture.sourceRoot), before);
    assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), inventory);
    const evidence = {
      provider: fixture.snapshot.format,
      sourceId,
      sourceItemKey: preview.items[0]!.sourceItemKey,
      before,
      after: stamp(fixture.sourceRoot),
      receipt: status.receipt,
      provenance: item.revision.provenance,
      pendingSync: item.pendingSync,
    };
    // Persist synthetic evidence outside the checkout when the remote runner requests it.
    if (process.env.WP5_IMPORT_EVIDENCE_DIR)
      NodeFS.writeFileSync(
        `${process.env.WP5_IMPORT_EVIDENCE_DIR}/${fixture.snapshot.format}.json`,
        JSON.stringify(evidence, null, 2),
      );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect.each(["codex-handbook-v1", "claude-topic-v1"] as const)(
  "c-6 assembled %s imports with provenance and unchanged original bytes/mtime",
  assembledImport,
);
hostGit.it(
  "c-6 assembled omo-memory-core-beta63 imports with provenance and unchanged original bytes/mtime",
  () => assembledImport("omo-memory-core-beta63"),
);

it.effect(
  "production defaults acquire reader and import from a synthetic home under umask 002 without snapshot setup",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporaryHome = yield* fs.makeTempDirectoryScoped({ prefix: "wp5-default-import-" });
      // macOS /tmp is a symlink; register the canonical synthetic root so the
      // production reader can retain its no-follow ancestor checks.
      const home = NodeFS.realpathSync(temporaryHome);
      const source = `${home}/.codex/memories`;
      yield* fs.makeDirectory(source, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(
        `${source}/MEMORY.md`,
        "# Task Group: Default assembly\nscope: synthetic fixture\n\n## Task 1: Import\n\n### learnings\n- Synthetic default assembly guidance.\n",
      );
      const before = stamp(source);
      // Only provider input exists here. Config prepares server state; the production
      // reader must create its own private snapshot directories without an override.
      assert.deepEqual(NodeFS.readdirSync(home), [".codex"]);
      // Scoped to this sequential test's worker; restore even when graph acquisition fails.
      if (posixPermissions)
        yield* Effect.acquireRelease(
          Effect.sync(() => process.umask(0o002)),
          (previous) => Effect.sync(() => process.umask(previous)),
        );
      const g = yield* graph(undefined, undefined, undefined, home);
      if (posixPermissions) assert.equal(NodeFS.lstatSync(g.stateDir).mode & 0o777, 0o700);
      assert.equal(
        (yield* Effect.serviceOption(ProviderMemoryImportRuntime).pipe(
          Effect.provideContext(g.context),
        ))._tag,
        "Some",
      );
      assert.equal(g.descriptor.capabilities.memory?.importProvider, true);
      for (const path of ["memory-import", "memory-import/snapshots"]) {
        const stat = NodeFS.lstatSync(`${g.stateDir}/${path}`);
        assert.isTrue(stat.isDirectory());
        assert.isFalse(stat.isSymbolicLink());
        if (posixPermissions) {
          assert.equal(stat.mode & 0o777, 0o700);
          assert.equal(stat.uid, process.getuid!());
        }
      }
      const discovered = yield* g.call({
        action: "discover",
        memorySpaceId: g.space,
        format: "codex",
      });
      if (discovered.action !== "discover") return assert.fail("discover");
      assert.lengthOf(discovered.sources, 1);
      const sourceId = discovered.sources[0]!.sourceId;
      const preview = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
      if (preview.action !== "preview") return assert.fail("preview");
      assert.lengthOf(preview.items, 1);
      const applied = yield* g.call({
        action: "apply",
        memorySpaceId: g.space,
        sourceId,
        sessionId: preview.sessionId,
        operationId: id(),
        items: preview.items.map((item) => ({
          sourceItemKey: item.sourceItemKey,
          sourceFingerprint: item.sourceFingerprint!,
          scope: { kind: "user" },
        })),
      });
      if (applied.action !== "apply") return assert.fail("apply");
      assert.equal(applied.receipt.state, "completed");
      assert.lengthOf(applied.receipt.items, 1);
      assert.equal(applied.receipt.items[0]!.outcome, "created");
      yield* g.tick;
      const item = yield* g.service.read(
        { memorySpaceId: g.space, memoryId: applied.receipt.items[0]!.memoryId! },
        Effect.void,
      );
      if (item.status !== "active") return assert.fail("active memory");
      assert.equal(item.pendingSync, false);
      assert.equal(item.revision.provenance.importSource?.sourceId, sourceId);
      assert.deepEqual(stamp(source), before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!posixPermissions)(
  "existing 0775 stateDir disables import with recovery guidance and keeps core and hub working",
  () => {
    const logs: unknown[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporaryHome = yield* fs.makeTempDirectoryScoped({ prefix: "wp5-shared-state-" });
      const home = NodeFS.realpathSync(temporaryHome);
      const stateDir = `${home}/userdata`;
      NodeFS.mkdirSync(stateDir);
      NodeFS.chmodSync(stateDir, 0o775);
      const g = yield* graph(undefined, undefined, undefined, home);
      assert.equal(NodeFS.lstatSync(stateDir).mode & 0o777, 0o775);
      assert.isFalse(NodeFS.existsSync(`${stateDir}/memory-import`));
      assert.equal(
        (yield* Effect.serviceOption(ProviderMemoryImportRuntime).pipe(
          Effect.provideContext(g.context),
        ))._tag,
        "None",
      );
      assert.isUndefined(g.descriptor.capabilities.memory?.importProvider);
      assert.equal(g.descriptor.capabilities.memory?.protocolVersion, 1);
      assert.equal(g.descriptor.capabilities.memoryHubProtocolVersion, 1);
      // This is a live core read and hub sync, not just capability labels.
      yield* g.tick;
      assert.equal(
        (yield* Context.get(g.context, Sync.MemorySyncService).readLocalReadiness()).bootstrap,
        "ready",
      );
      assert.deepEqual(
        (yield* g.service.list(
          { memorySpaceId: g.space, limit: 10, includeQuarantined: false },
          Effect.void,
        )).items,
        [],
      );
      const unavailable = yield* g
        .call({
          action: "discover",
          memorySpaceId: g.space,
          format: "codex",
        })
        .pipe(Effect.flip);
      assert.equal(unavailable._tag, "MemoryRpcError");
      const warning = logs.find(
        (message) => Array.isArray(message) && message[0] === "Provider memory import unavailable",
      );
      assert.deepEqual(warning, [
        "Provider memory import unavailable",
        {
          issue: "path_rejected",
          stateDir,
          recovery:
            "Match the stateDir owner to the server execution UID. If shared writes are not needed, remove group/other write permission and restart. If shared writes are needed, use a dedicated stateDir.",
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Logger.layer([
            Logger.make(({ message }) => {
              logs.push(message);
            }),
          ]),
        ),
      ),
    );
  },
);

it.effect(
  "reader acquisition failure preserves core and hub capability without advertising import",
  () =>
    Effect.gen(function* () {
      const g = yield* graph({ stateDir: "relative-invalid", roots: [] });
      assert.equal(g.descriptor.capabilities.memory?.protocolVersion, 1);
      assert.isUndefined(g.descriptor.capabilities.memory?.importProvider);
      assert.equal(g.descriptor.capabilities.memoryHubProtocolVersion, 1);
      assert.equal(
        (yield* g
          .call({ action: "discover", memorySpaceId: g.space, format: "codex" })
          .pipe(Effect.flip))._tag,
        "MemoryRpcError",
      );
      assert.equal(
        (yield* Effect.serviceOption(ProviderMemoryImportRuntime).pipe(
          Effect.provideContext(g.context),
        ))._tag,
        "None",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

hostGit.it(
  "both grants are rechecked after real reader waits for discover, preview and apply",
  () =>
    Effect.gen(function* () {
      const fixture = yield* buildMemoryImportFixture("omo-memory-core-beta63");
      let active: readonly M.AuthEnvironmentScope[] = grants;
      let barrier:
        | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
        | undefined;
      const g = yield* graph(
        {
          stateDir: fixture.stateDir,
          gitExecutable,
          roots: [{ format: "omo", rootSlot: "synthetic", path: fixture.trustedRoot }],
          onSnapshotSealed: () =>
            barrier
              ? Deferred.succeed(barrier.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(barrier.release)),
                )
              : Effect.void,
        },
        Effect.sync(() => active),
      );
      const d = yield* g.call({ action: "discover", memorySpaceId: g.space, format: "omo" });
      if (d.action !== "discover") return assert.fail("discover");
      const sourceId = d.sources[0]!.sourceId;
      const p = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
      if (p.action !== "preview") return assert.fail("preview");
      const actions: readonly M.MemoryImportProviderInput[] = [
        { action: "discover", memorySpaceId: g.space, format: "omo" },
        { action: "preview", memorySpaceId: g.space, sourceId },
        {
          action: "apply",
          memorySpaceId: g.space,
          sourceId,
          sessionId: p.sessionId,
          operationId: id(),
          items: p.items.map((i) => ({
            sourceItemKey: i.sourceItemKey,
            sourceFingerprint: i.sourceFingerprint!,
            scope: { kind: "user" },
          })),
        },
      ];
      for (const missing of grants)
        for (const input of actions) {
          active = grants;
          barrier = {
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          const request = yield* g.call(input).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(barrier.entered);
          active = grants.filter((scope) => scope !== missing);
          yield* Deferred.succeed(barrier.release, undefined);
          const result = yield* Fiber.join(request);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure._tag, "MemoryRpcError");
          barrier = undefined;
        }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("both grants are rechecked after SQL contention for all four actions", () =>
  Effect.gen(function* () {
    const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
    let active: readonly M.AuthEnvironmentScope[] = grants;
    let permitEntered: Deferred.Deferred<void> | undefined;
    const scopes = Effect.suspend(() =>
      permitEntered
        ? Deferred.succeed(permitEntered, undefined).pipe(Effect.as(active))
        : Effect.succeed(active),
    );
    const g = yield* graph(
      {
        stateDir: fixture.stateDir,
        gitExecutable,
        roots: [{ format: "codex", rootSlot: "synthetic", path: fixture.trustedRoot }],
      },
      scopes,
    );
    const d = yield* g.call({ action: "discover", memorySpaceId: g.space, format: "codex" });
    if (d.action !== "discover") return assert.fail("discover");
    const sourceId = d.sources[0]!.sourceId;
    const p = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
    if (p.action !== "preview") return assert.fail("preview");
    const apply: M.MemoryImportProviderInput = {
      action: "apply",
      memorySpaceId: g.space,
      sourceId,
      sessionId: p.sessionId,
      operationId: id(),
      items: p.items.map((i) => ({
        sourceItemKey: i.sourceItemKey,
        sourceFingerprint: i.sourceFingerprint!,
        scope: { kind: "user" },
      })),
    };
    yield* g.call(apply);
    const store = Context.get(g.context, Store.MemoryStore);
    for (const missing of grants)
      for (const input of [
        { action: "discover", memorySpaceId: g.space, format: "codex" },
        { action: "preview", memorySpaceId: g.space, sourceId },
        { ...apply, operationId: id() },
        { action: "status", memorySpaceId: g.space, operationId: apply.operationId },
      ] as const) {
        active = grants;
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holding = yield* store
          .transact(
            Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        permitEntered = yield* Deferred.make<void>();
        const request = yield* g.call(input).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(permitEntered);
        active = grants.filter((scope) => scope !== missing);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holding);
        const result = yield* Fiber.join(request);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure._tag, "MemoryRpcError");
        permitEntered = undefined;
      }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([1, 2] as const)(
  "lost response after %s real item commits returns the persisted receipt without source reads",
  (stopAfter) =>
    Effect.gen(function* () {
      const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1", {
        files: {
          "extensions/ad_hoc/notes/a.md": "Synthetic first guidance.",
          "extensions/ad_hoc/notes/b.md": "Synthetic second guidance.",
        },
      });
      let reads = 0;
      let commits = 0;
      const committed = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const observer = Effect.suspend(() =>
        ++commits === stopAfter
          ? Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(gate)))
          : Effect.void,
      );
      const g = yield* graph(
        {
          stateDir: fixture.stateDir,
          roots: [{ format: "codex", rootSlot: "synthetic", path: fixture.trustedRoot }],
          onSourceRead: () => {
            reads++;
          },
        },
        undefined,
        observer,
      );
      const d = yield* g.call({ action: "discover", memorySpaceId: g.space, format: "codex" });
      if (d.action !== "discover") return assert.fail("discover");
      const sourceId = d.sources[0]!.sourceId;
      const p = yield* g.call({ action: "preview", memorySpaceId: g.space, sourceId });
      if (p.action !== "preview") return assert.fail("preview");
      const operationId = id();
      const request = yield* g
        .call({
          action: "apply",
          memorySpaceId: g.space,
          sourceId,
          sessionId: p.sessionId,
          operationId,
          items: p.items.map((i) => ({
            sourceItemKey: i.sourceItemKey,
            sourceFingerprint: i.sourceFingerprint!,
            scope: { kind: "user" },
          })),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      yield* Fiber.interrupt(request);
      const readCount = reads;
      const status = yield* g.call({ action: "status", memorySpaceId: g.space, operationId });
      if (status.action !== "status") return assert.fail("status");
      assert.equal(status.receipt.state, stopAfter === 1 ? "partial" : "completed");
      assert.lengthOf(status.receipt.items, stopAfter);
      assert.equal(status.receipt.remaining, 2 - stopAfter);
      assert.equal(reads, readCount);
      assert.equal(commits, stopAfter);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "aside-semantic-v1 imports Current sections read-only, idempotently, with durable forget and project-only projects/",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "aside-import-" });
      const root = `${base}/u`;
      const memory = `${root}/slot-a/memory`;
      const stateDir = `${base}/state`;
      NodeFS.mkdirSync(stateDir, { mode: 0o700 });
      const write = (path: string, text: string) => {
        NodeFS.mkdirSync(`${memory}/${path}`.split("/").slice(0, -1).join("/"), {
          recursive: true,
        });
        NodeFS.writeFileSync(`${memory}/${path}`, text);
      };
      const page = (current: string, title = "Synthetic tools") =>
        `---\ntitle: ${title}\naliases: [kit]\n---\n## Current\n\n${current}\n\n## History\n\n- 2026-10-01: older note.\n`;
      const tools = (git: string) =>
        page(
          `Prefer small commits.\n\n### ${git}\n\nRebase before pushing.\n\n### Shell\n\nSearch with rg first.`,
        );
      // Derived briefings, logs, run logs and indexes sit beside the semantic pages.
      write("MEMORY.md", page("Derived briefing."));
      write("USER.md", page("Derived user briefing."));
      write(".history.jsonl", "{}\n");
      write("memory-index.json", "{}\n");
      write("episodic/2026-10-01.md", page("Observation log."));
      write("routines/r1/MEMORY.md", page("Routine state."));
      write("agent/tools.md", tools("Git"));
      write("agent/broken.md", "---\ntitle: Broken\n---\n## History\n\nNo current section.\n");
      write("agent/huge.md", page("y".repeat(300 * 1024)));
      const syntheticSecret = `sk-${"synthetic".repeat(4)}`;
      write("agent/secret.md", page(`Do not import ${syntheticSecret}`));
      write("agent/nul.md", page("Invalid\0text"));
      write("agent/2026-10-02.md", page("Dated log."));
      write("agent/nested/inner.md", page("Nested page."));
      NodeFS.symlinkSync(`${memory}/MEMORY.md`, `${memory}/agent/link.md`);
      write("projects/goat.md", page("Ship small PRs.", "GOAT"));
      write("sites/readme.txt", "not a page");
      // Skipped entries do not count against the 512-page budget.
      for (let n = 0; n < 600; n++) write(`agent/2026-01-01-${n}.md`, "log");
      for (let n = 0; n < 260; n++) {
        NodeFS.mkdirSync(`${memory}/agent/skip-dir-${n}.md`);
        NodeFS.symlinkSync(`${memory}/MEMORY.md`, `${memory}/agent/skip-link-${n}.md`);
      }
      NodeFS.mkdirSync(`${memory}/sites/folder.md`);
      NodeFS.mkdirSync(`${memory}/people`);
      const before = stamp(root);
      const g = yield* graph({
        stateDir,
        roots: [{ format: "aside", rootSlot: "synthetic", path: root }],
      });
      assert.equal(g.descriptor.capabilities.memory?.asideImport, true);
      const discovered = yield* g.call({
        action: "discover",
        memorySpaceId: g.space,
        format: "aside",
      });
      if (discovered.action !== "discover") return assert.fail("discover");
      assert.deepEqual(
        discovered.sources.map((s) => [s.label, s.format, s.profile]),
        [
          ["slot-a/agent", "aside", "aside-semantic-v1"],
          ["slot-a/projects", "aside", "aside-semantic-v1"],
          ["slot-a/sites", "aside", "aside-semantic-v1"],
        ],
      );
      const [agent, projects, sites] = discovered.sources.map((s) => s.sourceId);
      const preview = (sourceId: M.MemoryImportSourceId) =>
        g
          .call({ action: "preview", memorySpaceId: g.space, sourceId })
          .pipe(
            Effect.flatMap((p) =>
              p.action === "preview" ? Effect.succeed(p) : Effect.die("preview"),
            ),
          );
      const apply = (
        p: {
          readonly sourceId: M.MemoryImportSourceId;
          readonly sessionId: string;
          readonly items: readonly M.MemoryImportPreviewItem[];
        },
        keep: (key: string) => boolean = () => true,
      ) =>
        g
          .call({
            action: "apply",
            memorySpaceId: g.space,
            sourceId: p.sourceId,
            sessionId: p.sessionId,
            operationId: id(),
            items: p.items
              .filter((item) => !item.issue && keep(item.sourceItemKey))
              .map((item) => ({
                sourceItemKey: item.sourceItemKey,
                sourceFingerprint: item.sourceFingerprint!,
                scope: { kind: "user" as const },
              })),
          })
          .pipe(
            Effect.flatMap((a) =>
              a.action === "apply" ? Effect.succeed(a.receipt) : Effect.die("apply"),
            ),
          );

      const first = yield* preview(agent!);
      assert.deepEqual((yield* preview(sites!)).items, []);
      assert.deepEqual(
        first.items.map((item) => [item.sourceItemKey, item.issue ?? null]),
        [
          ["agent/broken.md#current", "unsupported_format"],
          ["agent/huge.md#current", "limit_exceeded"],
          ["agent/nul.md#current", "invalid_utf8"],
          ["agent/secret.md#current", "secret_detected"],
          ["agent/tools.md#current", null],
          ["agent/tools.md#current:Git", null],
          ["agent/tools.md#current:Shell", null],
        ],
      );
      assert.isAbove(first.items[1]!.byteCount, 256 * 1024);
      assert.notInclude(JSON.stringify(first), syntheticSecret);
      const created = yield* apply(first);
      assert.deepEqual(
        created.items.map((item) => item.outcome),
        ["created", "created", "created"],
      );
      yield* g.tick;
      const git = created.items.find((item) => item.sourceItemKey.endsWith(":Git"))!;
      const item = yield* g.service.read(
        { memorySpaceId: g.space, memoryId: git.memoryId! },
        Effect.void,
      );
      if (item.status !== "active") return assert.fail("active memory");
      assert.equal(item.payload.text, "Synthetic tools: Git\n\nRebase before pushing.");
      // Hub protocol v1 peers decode provenance formats strictly; the profile names the source.
      assert.deepInclude(item.revision.provenance.importSource, {
        format: "omo",
        parserVersion: "aside-semantic-v1",
        sourceLocator: "aside/synthetic/slot-a:agent",
        sourceItemKey: "agent/tools.md#current:Git",
      });

      // Re-importing unchanged pages is a no-op.
      const repeated = yield* apply(yield* preview(agent!));
      assert.deepEqual(
        repeated.items.map((item) => item.outcome),
        ["noop", "noop", "noop"],
      );

      // A forgotten section stays suppressed after its H3 is renamed.
      yield* g.service.forget(
        {
          memorySpaceId: g.space,
          memoryId: git.memoryId!,
          operationId: id(),
          expectedHeads: [item.revision.revisionId],
        },
        Effect.void,
      );
      yield* g.tick;
      assert.deepEqual(stamp(root), before);
      write("agent/tools.md", tools("Git usage"));
      const renamed = yield* preview(agent!);
      assert.include(
        renamed.items.map((i) => i.sourceItemKey),
        "agent/tools.md#current:Git usage",
      );
      const suppressed = yield* apply(renamed, (key) => key.endsWith(":Git usage"));
      assert.deepEqual(
        suppressed.items.map((i) => [i.sourceItemKey, i.outcome]),
        [["agent/tools.md#current:Git usage", "suppressed"]],
      );

      // projects/ pages need an explicit project binding.
      const project = yield* preview(projects!);
      assert.deepEqual(
        project.items.map((i) => [i.sourceItemKey, i.mappingRequired]),
        [["projects/goat.md#current", true]],
      );
      const refused = yield* apply(project).pipe(Effect.flip);
      assert.equal(refused._tag, "MemoryImportRpcError");
      if (refused._tag === "MemoryImportRpcError") assert.equal(refused.issue, "scope_unmapped");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
