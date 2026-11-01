import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as Store from "./MemoryStore.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Resolver from "../project/RepositoryIdentityResolver.ts";

const decodeHubView = Schema.decodeUnknownEffect(M.MemoryHubSettingsView);
const decodeClientSettings = Schema.decodeUnknownEffect(M.ServerSettings);
const encodeClientSettings = Schema.encodeEffect(M.ServerSettings);
const isStoreConflict = Schema.is(Store.MemoryStoreConflict);

const environmentId = M.EnvironmentId.make("environment-fixture");
const dependencies = Store.layer.pipe(
  Layer.provideMerge(Persistence.layerConfig),
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-default-memory-" })),
  Layer.provideMerge(
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const id = (n: number) =>
  M.MemoryOperationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const settingsSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Settings.layer));
const start = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  yield* settings.start;
  return yield* Hub.makeAdministrator;
});

it.effect(
  "a fresh environment initializes exactly one durable ready hub and preserves its credential on restart",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* settingsSession(
        Effect.gen(function* () {
          const admin = yield* start;
          assert.strictEqual(yield* admin.initializeDefaultHub, "initialized");
          assert.strictEqual(yield* admin.initializeDefaultHub, "already_initialized");
          const view = yield* (yield* Settings.MemoryHubAdminSettings).read;
          assert.strictEqual(view.settings.mode, "hub");
          assert.strictEqual(view.version, 1);
          assert.isNotNull(view.provenance);
          const space = view.provenance!.memorySpaceId;
          const wire = yield* Hub.readSettingsView(store, view);
          assert.deepStrictEqual(Object.keys(wire).sort(), ["members", "settings", "version"]);
          yield* decodeHubView(wire, {
            onExcessProperty: "error",
          });
          const clientSettings = Settings.redactServerSettingsForClient(
            yield* (yield* Settings.ServerSettingsService).getSettings,
          );
          assert.isFalse(Object.hasOwn(clientSettings, "memoryHubProvenance"));
          yield* decodeClientSettings(yield* encodeClientSettings(clientSettings), {
            onExcessProperty: "error",
          });
          yield* Effect.gen(function* () {
            const service = yield* Service.MemoryService;
            const memoryId = M.MemoryId.make("00000000-0000-4000-8000-000000000020");
            yield* service.upsert(
              {
                memorySpaceId: space,
                memoryId,
                operationId: id(21),
                expectedHeads: [],
                scope: { kind: "user" },
                assertionKind: "inference",
                payload: {
                  text: "fixture remembered fact",
                  evidence: [],
                  derivedFromMemoryRevisions: [],
                },
                baseBoundary: null,
              },
              Effect.void,
            );
            const page = yield* service.read({ memorySpaceId: space, memoryId }, Effect.void);
            assert.strictEqual(
              page.status === "active" ? page.payload.text : null,
              "fixture remembered fact",
            );
            assert.strictEqual(
              (yield* store.loadAggregate(space, memoryId)).item?.memoryId,
              memoryId,
            );
          }).pipe(
            Effect.provide(
              Service.layer.pipe(
                Layer.provide(Quota.layer),
                Layer.provide(
                  Layer.mock(Resolver.RepositoryIdentityResolver)({
                    resolve: () => Effect.succeed(null),
                  }),
                ),
              ),
            ),
          );
          const member = yield* store.readHubMember(space, environmentId);
          assert.strictEqual(member?.status, "active");
          assert.strictEqual(
            (yield* store.transact(store.readHubRetentionTx(space))).checkpointId !== null,
            true,
          );
          return { space, member };
        }),
      );
      yield* settingsSession(
        Effect.gen(function* () {
          const admin = yield* start;
          assert.strictEqual(yield* admin.initializeDefaultHub, "already_initialized");
          const view = yield* (yield* Settings.MemoryHubAdminSettings).read;
          assert.strictEqual(view.provenance?.memorySpaceId, first.space);
          assert.deepStrictEqual(
            yield* store.readHubMember(first.space, environmentId),
            first.member,
          );
          yield* admin.update(
            {
              requestId: id(3),
              expectedVersion: 1,
              action: "configure",
              settings: { mode: "hub", memorySpaceId: first.space },
            },
            Effect.void,
          );
          assert.isNull((yield* (yield* Settings.MemoryHubAdminSettings).read).provenance);
          assert.strictEqual(yield* admin.initializeDefaultHub, "preserved");
        }),
      );
      assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM memory_hub_members`, [{ n: 1 }]);
      assert.deepStrictEqual(yield* sql`SELECT administered FROM memory_hub_administration_state`, [
        { administered: 1 },
      ]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect.each(["delete", "truncate", "fields"] as const)(
  "explicit disable at version zero survives restart with %s settings",
  (damage) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      yield* settingsSession(
        Effect.gen(function* () {
          const admin = yield* start;
          yield* admin.update(
            {
              requestId: id(5),
              expectedVersion: 0,
              action: "configure",
              settings: { mode: "disabled" },
            },
            Effect.void,
          );
        }),
      );
      if (damage === "delete") yield* fs.remove(config.settingsPath);
      else yield* fs.writeFileString(config.settingsPath, damage === "truncate" ? "{" : "{}");
      yield* settingsSession(
        Effect.gen(function* () {
          const admin = yield* start;
          const before = yield* sql`SELECT admin_json FROM memory_outbox WHERE kind='admin'`;
          assert.strictEqual(yield* admin.initializeDefaultHub, "preserved");
          assert.strictEqual(
            (yield* (yield* Settings.ServerSettingsService).getSettings).memoryHub.mode,
            "disabled",
          );
          assert.deepStrictEqual(
            yield* sql`SELECT admin_json FROM memory_outbox WHERE kind='admin'`,
            before,
          );
        }),
      );
    }).pipe(Effect.provide(dependencies)),
);
it.effect(
  "deleting settings after default initialization preserves off rather than recreating the hub",
  () =>
    Effect.gen(function* () {
      yield* settingsSession(
        Effect.gen(function* () {
          assert.strictEqual(yield* (yield* start).initializeDefaultHub, "initialized");
        }),
      );
      yield* (yield* FileSystem.FileSystem).remove((yield* Config.ServerConfig).settingsPath);
      yield* settingsSession(
        Effect.gen(function* () {
          assert.strictEqual(yield* (yield* start).initializeDefaultHub, "preserved");
          assert.strictEqual(
            (yield* (yield* Settings.ServerSettingsService).getSettings).memoryHub.mode,
            "disabled",
          );
        }),
      );
    }).pipe(Effect.provide(dependencies)),
);

it.effect.each(["prepared", "activated", "settings"] as const)(
  "restart resumes hub initialization after %s without creating another space",
  (stage) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* settingsSession(
        Effect.gen(function* () {
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.start;
          const backend = yield* Settings.MemoryHubAdminSettings;
          const written = yield* Deferred.make<void>();
          const admin = yield* Hub.makeAdministrator.pipe(
            Effect.provideService(Hub.MemoryHubAdminSettings, {
              ...backend,
              apply: (record, permit) =>
                stage === "activated"
                  ? Deferred.succeed(written, undefined).pipe(Effect.andThen(Effect.never))
                  : backend
                      .apply(record, permit)
                      .pipe(
                        Effect.tap(() =>
                          stage === "settings"
                            ? Deferred.succeed(written, undefined).pipe(
                                Effect.andThen(Effect.never),
                              )
                            : Effect.void,
                        ),
                      ),
            }),
            Effect.provideService(Store.MemoryStore, {
              ...store,
              writeHubAdminTx: (input) =>
                store
                  .writeHubAdminTx(input)
                  .pipe(
                    Effect.tap(() =>
                      stage === "prepared" && input.record.stage === "prepared"
                        ? Deferred.succeed(written, undefined)
                        : Effect.void,
                    ),
                  ),
              // A post-commit barrier, so the prepared receipt really survives interruption.
              transact: (effect) =>
                store.transact(effect).pipe(
                  Effect.tap(() =>
                    stage === "prepared"
                      ? Effect.gen(function* () {
                          if (yield* Deferred.isDone(written)) return yield* Effect.never;
                        })
                      : Effect.void,
                  ),
                ),
            }),
          );
          const fiber = yield* admin.initializeDefaultHub.pipe(Effect.forkScoped);
          yield* Deferred.await(written);
          yield* Fiber.interrupt(fiber);
        }),
      );
      yield* settingsSession(
        Effect.gen(function* () {
          const admin = yield* start;
          assert.strictEqual(yield* admin.initializeDefaultHub, "initialized");
          assert.strictEqual(yield* admin.initializeDefaultHub, "already_initialized");
        }),
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM memory_hub_members`, [{ n: 1 }]);
      assert.deepStrictEqual(
        yield* sql`SELECT count(*) AS n FROM memory_outbox WHERE kind='admin'`,
        [{ n: 1 }],
      );
    }).pipe(Effect.provide(dependencies)),
);

it.effect("a user disable queued during initialization wins and remains off after restart", () =>
  Effect.gen(function* () {
    yield* settingsSession(
      Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.start;
        const backend = yield* Settings.MemoryHubAdminSettings;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const initializing = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Hub.MemoryHubAdminSettings, {
            ...backend,
            apply: (record, permit) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(backend.apply(record, permit)),
              ),
          }),
        );
        const fiber = yield* initializing.initializeDefaultHub.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const manual = yield* Hub.makeAdministrator;
        const queued = yield* manual
          .update(
            {
              requestId: id(8),
              expectedVersion: 1,
              action: "configure",
              settings: { mode: "disabled" },
            },
            Effect.void,
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        assert.strictEqual((yield* Fiber.join(queued)).view.settings.mode, "disabled");
      }),
    );
    yield* settingsSession(
      Effect.gen(function* () {
        assert.strictEqual(yield* (yield* start).initializeDefaultHub, "preserved");
        assert.strictEqual(
          (yield* (yield* Settings.ServerSettingsService).getSettings).memoryHub.mode,
          "disabled",
        );
      }),
    );
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "an observable version-zero disable is refused after initialization and a fresh retry survives restart",
  () =>
    Effect.gen(function* () {
      yield* settingsSession(
        Effect.gen(function* () {
          yield* (yield* Settings.ServerSettingsService).start;
          const backend = yield* Settings.MemoryHubAdminSettings;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const submitted = yield* Deferred.make<void>();
          const initializing = yield* Hub.makeAdministrator.pipe(
            Effect.provideService(Hub.MemoryHubAdminSettings, {
              ...backend,
              apply: (record, permit) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(backend.apply(record, permit)),
                ),
            }),
          );
          const initialization = yield* initializing.initializeDefaultHub.pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const observable = yield* Hub.readSettingsView(
            yield* Store.MemoryStore,
            yield* backend.read,
          );
          assert.strictEqual(observable.version, 0);
          assert.strictEqual(observable.settings.mode, "disabled");
          const manual = yield* Hub.makeAdministrator.pipe(
            Effect.provideService(Hub.MemoryHubAdminSettings, {
              ...backend,
              withLock: (effect) =>
                Deferred.succeed(submitted, undefined).pipe(
                  Effect.andThen(backend.withLock(effect)),
                ),
            }),
          );
          const request = {
            requestId: id(80),
            expectedVersion: observable.version,
            action: "configure" as const,
            settings: { mode: "disabled" as const },
          };
          const disabling = yield* manual
            .update(request, Effect.void)
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(submitted);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(initialization);
          const refused = yield* Fiber.join(disabling);
          assert.isTrue(Exit.isFailure(refused));
          if (Exit.isFailure(refused)) {
            const error = Cause.squash(refused.cause);
            assert.isTrue(isStoreConflict(error));
            if (isStoreConflict(error)) assert.strictEqual(error.code, "revision_changed");
          }
          const current = yield* backend.read;
          assert.strictEqual(current.version, 1);
          assert.strictEqual(current.settings.mode, "hub");
          const retried = yield* manual.update(
            { ...request, requestId: id(81), expectedVersion: current.version },
            Effect.void,
          );
          assert.strictEqual(retried.view.settings.mode, "disabled");
          assert.strictEqual(retried.view.version, 2);
          assert.deepStrictEqual(Object.keys(retried.view).sort(), [
            "members",
            "settings",
            "version",
          ]);
        }),
      );
      yield* settingsSession(
        Effect.gen(function* () {
          assert.strictEqual(yield* (yield* start).initializeDefaultHub, "preserved");
          const restarted = yield* (yield* Settings.MemoryHubAdminSettings).read;
          assert.strictEqual(restarted.settings.mode, "disabled");
          assert.strictEqual(restarted.version, 2);
          assert.isNull(restarted.provenance);
        }),
      );
    }).pipe(Effect.provide(dependencies)),
);

it.effect("a malformed fresh settings file fails closed without administration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    yield* fs.writeFileString(config.settingsPath, "{");
    yield* settingsSession(
      Effect.gen(function* () {
        assert.strictEqual(yield* (yield* start).initializeDefaultHub, "preserved");
        assert.strictEqual(
          (yield* (yield* Settings.ServerSettingsService).getSettings).memoryHub.mode,
          "disabled",
        );
        const store = yield* Store.MemoryStore;
        assert.isFalse(yield* store.transact(store.hasHubAdministrationTx()));
      }),
    );
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "roster administration preserves automatic origin and a credential installation clears it",
  () =>
    Effect.gen(function* () {
      yield* settingsSession(
        Effect.gen(function* () {
          const admin = yield* start;
          yield* admin.initializeDefaultHub;
          const initial = yield* (yield* Settings.MemoryHubAdminSettings).read;
          const memberId = M.EnvironmentId.make("other-fixture");
          yield* admin.update(
            {
              requestId: id(30),
              expectedVersion: 1,
              action: "provisionMember",
              environmentId: memberId,
            },
            Effect.void,
          );
          assert.deepStrictEqual(
            (yield* (yield* Settings.MemoryHubAdminSettings).read).provenance,
            initial.provenance,
          );
          yield* admin.update(
            {
              requestId: id(31),
              expectedVersion: 2,
              action: "acknowledgeCredential",
              credentialRequestId: id(30),
            },
            Effect.void,
          );
          assert.deepStrictEqual(
            (yield* (yield* Settings.MemoryHubAdminSettings).read).provenance,
            initial.provenance,
          );
          const installed = yield* admin.update(
            {
              requestId: id(32),
              expectedVersion: 3,
              action: "installCredential",
              hubEnvironmentId: memberId,
              endpoint: "https://fixture.example",
              memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000033"),
              credential: "a".repeat(43),
            },
            Effect.void,
          );
          assert.isNull((yield* (yield* Settings.MemoryHubAdminSettings).read).provenance);
          assert.strictEqual(installed.view.settings.mode, "member");
          assert.strictEqual(yield* admin.initializeDefaultHub, "preserved");
        }),
      );
    }).pipe(Effect.provide(dependencies)),
);

it.effect("a user disable that acquires the administration lock first fences initialization", () =>
  Effect.gen(function* () {
    yield* settingsSession(
      Effect.gen(function* () {
        const admin = yield* start;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const backend = yield* Settings.MemoryHubAdminSettings;
        const disabling = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Hub.MemoryHubAdminSettings, {
            ...backend,
            apply: (record, permit) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(backend.apply(record, permit)),
              ),
          }),
        );
        const disable = yield* disabling
          .update(
            {
              requestId: id(40),
              expectedVersion: 0,
              action: "configure",
              settings: { mode: "disabled" },
            },
            Effect.void,
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const initializing = yield* admin.initializeDefaultHub.pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(disable);
        assert.strictEqual(yield* Fiber.join(initializing), "preserved");
      }),
    );
    yield* settingsSession(
      Effect.gen(function* () {
        assert.strictEqual(yield* (yield* start).initializeDefaultHub, "preserved");
      }),
    );
  }).pipe(Effect.provide(dependencies)),
);

const fileCodec = Schema.fromJsonString(
  Schema.Struct({
    ...M.ServerSettings.fields,
    _memoryHubTransition: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeFile = Schema.decodeUnknownEffect(fileCodec);
const encodeFile = Schema.encodeEffect(fileCodec);
it.effect.each(["missing-marker", "mismatched-space"] as const)(
  "external replacement with %s cannot claim automatic provenance",
  (replacement) =>
    Effect.gen(function* () {
      yield* settingsSession(
        Effect.gen(function* () {
          yield* (yield* start).initializeDefaultHub;
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const { _memoryHubTransition: marker, ...settings } = yield* decodeFile(
        yield* fs.readFileString(config.settingsPath),
      );
      const next =
        replacement === "missing-marker"
          ? settings
          : {
              ...settings,
              memoryHubProvenance: {
                source: "auto-initialized" as const,
                memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000050"),
              },
              _memoryHubTransition: marker,
            };
      yield* fs.writeFileString(config.settingsPath, yield* encodeFile(next));
      yield* settingsSession(
        Effect.gen(function* () {
          assert.strictEqual(yield* (yield* start).initializeDefaultHub, "preserved");
          assert.isNull((yield* (yield* Settings.MemoryHubAdminSettings).read).provenance);
        }),
      );
    }).pipe(Effect.provide(dependencies)),
);
