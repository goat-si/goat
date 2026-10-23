import {
  BoatSandboxId,
  CLOUD_MACHINE_READY_STATES,
  CloudMachineAlias,
  CloudMachineError,
  CloudMachineTtlSeconds,
  CloudMachineType,
  cloudMachineAlias,
  type CloudMachine,
  type CloudMachineErrorReason,
  type CloudMachinesConfigureInput,
  type CloudMachinesCreateInput,
  type CloudMachinesEnsureReadyResult,
  type CloudMachinesListResult,
  type CloudMachineState,
} from "@goat/contracts";
import * as KeyedLock from "@goat/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Crypto from "effect/Crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { BoatClient, type BoatSandbox } from "./BoatClient.ts";
import { CloudMachineSsh } from "./sshConfig.ts";

/**
 * Owns the Boat machines this GOAT server created: the API key, a private catalog of owned
 * sandbox ids, and keeping each machine's SSH alias current. Only explicit actions wake a stopped
 * machine (`wake: true`); status checks, host lists and background polling never do, and never
 * extend its auto-stop time. A catalog entry is removed only after Boat confirms the machine is
 * gone or the user forgets a stopped one, so GOAT never loses track of a machine that may bill.
 */

const BOAT_API_KEY_SECRET = "cloud-machines-boat-api-key";
const CATALOG_FILE = "cloud-machines.json";
/** A non-waking check reuses a confirmed SSH mapping this long before asking Boat again. */
const QUIET_REFRESH_MS = 60_000;
export const READY_DEADLINE_MS = 180_000;
const READY_POLL = "2 seconds";
/** Boat keeps an Idempotency-Key for 24 hours; an older unresolved create cannot be replayed. */
const PENDING_CREATE_MAX_AGE_MS = 23 * 60 * 60 * 1000;

const StoredMachine = Schema.Struct({
  sandboxId: BoatSandboxId,
  alias: CloudMachineAlias,
  label: Schema.String,
  type: CloudMachineType,
  ttlSeconds: CloudMachineTtlSeconds,
  deletePending: Schema.Boolean,
});
type StoredMachine = typeof StoredMachine.Type;

/** Written before a create request, so a lost response is replayed with the same key. */
const PendingCreate = Schema.Struct({
  idempotencyKey: Schema.String,
  label: Schema.String,
  type: CloudMachineType,
  ttlSeconds: CloudMachineTtlSeconds,
  requestedAt: Schema.Number,
});
type PendingCreate = typeof PendingCreate.Type;

const Catalog = Schema.Struct({
  version: Schema.Literal(1),
  machines: Schema.Array(StoredMachine),
  pendingCreates: Schema.Array(PendingCreate),
});
type Catalog = typeof Catalog.Type;
const CatalogJson = Schema.fromJsonString(Catalog);
const decodeCatalog = Schema.decodeUnknownEffect(CatalogJson);
const encodeCatalog = Schema.encodeEffect(CatalogJson);
const EMPTY_CATALOG: Catalog = { version: 1, machines: [], pendingCreates: [] };

export interface EnsureReadyOptions {
  /** Resume a stopped machine and extend its auto-stop time. Only for explicit actions. */
  readonly wake: boolean;
}

/**
 * Why an alias's SSH caches were dropped: `endpoint` when a running machine got a new address or
 * host key, `lifecycle` when it was stopped, deleted, forgotten or its key was disconnected.
 */
export type CloudAliasInvalidation = "endpoint" | "lifecycle";

export class CloudMachineService extends Context.Service<
  CloudMachineService,
  {
    readonly changes: Stream.Stream<void>;
    readonly catalog: Effect.Effect<
      ReadonlyArray<{ readonly alias: CloudMachineAlias; readonly label: string }>,
      CloudMachineError
    >;
    readonly list: () => Effect.Effect<CloudMachinesListResult, CloudMachineError>;
    readonly configure: (
      input: CloudMachinesConfigureInput,
    ) => Effect.Effect<{ readonly configured: true }, CloudMachineError>;
    /** Removes the key and SSH files; keeps the catalog so running machines stay visible. */
    readonly disconnect: () => Effect.Effect<{ readonly configured: false }, CloudMachineError>;
    readonly create: (
      input: CloudMachinesCreateInput,
    ) => Effect.Effect<CloudMachine, CloudMachineError>;
    readonly stop: (alias: CloudMachineAlias) => Effect.Effect<CloudMachine, CloudMachineError>;
    readonly resume: (alias: CloudMachineAlias) => Effect.Effect<CloudMachine, CloudMachineError>;
    readonly delete: (alias: CloudMachineAlias) => Effect.Effect<CloudMachine, CloudMachineError>;
    readonly forget: (
      alias: CloudMachineAlias,
    ) => Effect.Effect<{ readonly forgotten: true }, CloudMachineError>;
    /**
     * The user checked Boat's dashboard; stop counting creates Boat can no longer resolve.
     * Newer requests, including any still in flight, stay so the next create replays them.
     */
    readonly dismissUnconfirmedCreates: () => Effect.Effect<
      { readonly dismissed: number },
      CloudMachineError
    >;
    readonly ensureReady: (
      alias: CloudMachineAlias,
      options: EnsureReadyOptions,
    ) => Effect.Effect<CloudMachinesEnsureReadyResult, CloudMachineError>;
    /** Whether this server manages the alias; reads only the local catalog. */
    readonly owns: (alias: string) => Effect.Effect<boolean>;
    /**
     * Runs `listener` after a machine's address or host key changed, or it was stopped, deleted
     * or disconnected, so SSH caches for that alias are dropped before the next connection.
     */
    readonly onAliasInvalidated: (
      listener: (alias: string, cause: CloudAliasInvalidation) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    /**
     * Runs `listener` each time a machine was readied and its SSH entry written, not for an
     * answer served from the recent-readiness cache. It runs under the alias lock, so it must not
     * wait on the machine; fork the work.
     */
    readonly onReady: (listener: (alias: string) => Effect.Effect<void>) => Effect.Effect<void>;
  }
>()("goat/cloudMachines/CloudMachineService") {}

const fail = (reason: CloudMachineErrorReason) => new CloudMachineError({ reason });

const make = Effect.gen(function* () {
  const boat = yield* BoatClient;
  const ssh = yield* CloudMachineSsh;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const catalogPath = path.join(config.stateDir, CATALOG_FILE);
  const catalogLock = yield* Semaphore.make(1);
  const signals = yield* PubSub.unbounded<void>();
  const aliasLocks = yield* KeyedLock.make<string>();
  const readyAt = new Map<string, number>();
  // Counts completed waking ensures, so a caller that queued behind one reuses its result.
  const wakeGenerations = new Map<string, number>();
  const lastErrors = new Map<string, CloudMachineErrorReason>();
  const listeners: Array<(alias: string, cause: CloudAliasInvalidation) => Effect.Effect<void>> =
    [];
  const readyListeners: Array<(alias: string) => Effect.Effect<void>> = [];

  const readCatalog = fs.exists(catalogPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(catalogPath).pipe(Effect.flatMap(decodeCatalog))
        : Effect.succeed(EMPTY_CATALOG),
    ),
    // An unreadable or newer catalog fails closed rather than being overwritten.
    Effect.mapError(() => fail("storage_failed")),
  );

  const writeCatalog = (catalog: Catalog) =>
    Effect.gen(function* () {
      const contents = yield* encodeCatalog(catalog);
      const temp = `${catalogPath}.${yield* crypto.randomUUIDv4()}.tmp`;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(temp, `${contents}\n`, { mode: 0o600, flag: "wx" }).pipe(
        Effect.andThen(fs.chmod(temp, 0o600)),
        Effect.andThen(fs.rename(temp, catalogPath)),
        Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.mapError(() => fail("storage_failed")),
      Effect.tap(() => PubSub.publish(signals, undefined)),
    );

  /** Serializes read-modify-write of the catalog. */
  const updateCatalog = <A>(f: (catalog: Catalog) => readonly [Catalog, A]) =>
    catalogLock.withPermits(1)(
      readCatalog.pipe(
        Effect.flatMap((catalog) => {
          const [next, result] = f(catalog);
          return next === catalog
            ? Effect.succeed(result)
            : writeCatalog(next).pipe(Effect.as(result));
        }),
      ),
    );

  const apiKey = secrets.get(BOAT_API_KEY_SECRET).pipe(
    Effect.mapError(() => fail("storage_failed")),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(fail("not_configured")),
        onSome: (bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
      }),
    ),
  );
  const isConfigured = secrets.get(BOAT_API_KEY_SECRET).pipe(
    Effect.map(Option.isSome),
    Effect.orElseSucceed(() => false),
  );

  const owned = (alias: string) =>
    readCatalog.pipe(
      Effect.flatMap((catalog) => {
        const machine = catalog.machines.find((entry) => entry.alias === alias);
        return machine === undefined ? Effect.fail(fail("not_found")) : Effect.succeed(machine);
      }),
    );

  const invalidate = (alias: string, cause: CloudAliasInvalidation) =>
    Effect.sync(() => readyAt.delete(alias)).pipe(
      Effect.andThen(
        Effect.forEach(listeners, (listener) => listener(alias, cause), { discard: true }),
      ),
    );

  const view = (
    machine: StoredMachine,
    remote:
      | { readonly presence: "present"; readonly state: CloudMachineState }
      | { readonly presence: "not_found" | "unknown"; readonly error?: CloudMachineErrorReason },
  ): CloudMachine => {
    const error =
      remote.presence === "present"
        ? lastErrors.get(machine.alias)
        : (remote.error ?? lastErrors.get(machine.alias));
    return {
      alias: machine.alias,
      sandboxId: machine.sandboxId,
      label: machine.label || machine.sandboxId,
      provider: "boat",
      type: machine.type,
      ttlSeconds: machine.ttlSeconds,
      presence: remote.presence,
      state: remote.presence === "present" ? remote.state : null,
      deletePending: machine.deletePending,
      lastError: error === undefined ? null : fail(error).message,
    };
  };

  /** Reads Boat's state; a machine the key cannot see is `not_found`, never an error. */
  const remoteOf = (key: string, machine: StoredMachine) =>
    boat.get(key, machine.sandboxId).pipe(
      Effect.map((sandbox) => ({ presence: "present" as const, state: sandbox.state })),
      Effect.catch((error) =>
        Effect.succeed(
          // Only a 404 means gone; a key without access must not make a machine look deleted.
          error.reason === "not_found"
            ? { presence: "not_found" as const }
            : { presence: "unknown" as const, error: error.reason },
        ),
      ),
    );

  const nameMachine = (key: string, machine: StoredMachine) =>
    boat.update(key, machine.sandboxId, { name: machine.label }).pipe(
      Effect.tap(() => Effect.sync(() => lastErrors.delete(machine.alias))),
      Effect.catch((error) => Effect.sync(() => lastErrors.set(machine.alias, error.reason))),
    );

  /** Sends a create that was journaled; the same key makes Boat return the same machine. */
  const sendCreate = (key: string, pending: PendingCreate) =>
    boat
      .create(key, { type: pending.type, ttlSeconds: pending.ttlSeconds }, pending.idempotencyKey)
      .pipe(
        Effect.tapError((error) =>
          // Only a lost response leaves the outcome unknown; anything else means no machine.
          error.reason === "transport_error"
            ? Effect.void
            : updateCatalog((catalog) => [
                {
                  ...catalog,
                  pendingCreates: catalog.pendingCreates.filter(
                    (entry) => entry.idempotencyKey !== pending.idempotencyKey,
                  ),
                },
                undefined,
              ]).pipe(Effect.ignore),
        ),
        Effect.flatMap((sandbox) =>
          updateCatalog((catalog) => {
            const machine: StoredMachine = {
              sandboxId: sandbox.id,
              alias: cloudMachineAlias(sandbox.id),
              label: pending.label,
              type: pending.type,
              ttlSeconds: pending.ttlSeconds,
              deletePending: false,
            };
            const known = catalog.machines.some((entry) => entry.sandboxId === sandbox.id);
            return [
              {
                ...catalog,
                machines: known ? catalog.machines : [...catalog.machines, machine],
                pendingCreates: catalog.pendingCreates.filter(
                  (entry) => entry.idempotencyKey !== pending.idempotencyKey,
                ),
              },
              { machine, sandbox },
            ];
          }),
        ),
      );

  /**
   * Replays creates whose response was lost, so their machines join the catalog. Runs only
   * from an explicit create. Boat forgets an Idempotency-Key after a day, so an older request
   * is never replayed (that would make a second machine); it stays counted in list() until the
   * user checks Boat's dashboard and dismisses it.
   */
  const resolvePendingCreates = (key: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const recent = (yield* readCatalog).pendingCreates.filter(
        (pending) => now - pending.requestedAt <= PENDING_CREATE_MAX_AGE_MS,
      );
      for (const pending of recent) {
        yield* sendCreate(key, pending).pipe(
          Effect.flatMap(({ machine }) => nameMachine(key, machine)),
          Effect.ignore,
        );
      }
    });

  const waitUntilReady = (key: string, machine: StoredMachine, wake: boolean) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + READY_DEADLINE_MS;
      let resumed = false;
      while (true) {
        const sandbox: BoatSandbox = yield* boat.get(key, machine.sandboxId);
        if (CLOUD_MACHINE_READY_STATES.has(sandbox.state)) return sandbox;
        if (sandbox.state === "error" || sandbox.state === "cancelled")
          return yield* fail("conflict");
        if (!wake)
          return yield* fail(
            sandbox.state === "archived" || sandbox.state === "archiving" ? "stopped" : "not_ready",
          );
        if (sandbox.state === "archived" && !resumed) {
          yield* boat.resume(key, machine.sandboxId);
          resumed = true;
          continue;
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) return yield* fail("readiness_timeout");
        yield* Effect.sleep(READY_POLL);
      }
    });

  const ensureReady = (alias: CloudMachineAlias, options: EnsureReadyOptions) =>
    Effect.gen(function* () {
      // Read before anything async, so only a wake that finishes after this call began is reused.
      const wakesSeen = wakeGenerations.get(alias) ?? 0;
      const machine = yield* owned(alias);
      if (machine.deletePending) return yield* fail("not_found");
      const fresh = (window: number) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => now - (readyAt.get(alias) ?? Number.NEGATIVE_INFINITY) < window),
        );
      if (!options.wake && (yield* fresh(QUIET_REFRESH_MS)))
        return { alias, endpointChanged: false };
      return yield* aliasLocks.withLock(
        alias,
        Effect.gen(function* () {
          const joined = options.wake
            ? (wakeGenerations.get(alias) ?? 0) > wakesSeen
            : yield* fresh(QUIET_REFRESH_MS);
          if (joined) return { alias, endpointChanged: false };
          const key = yield* apiKey;
          yield* waitUntilReady(key, machine, options.wake);
          const { publicKey } = yield* ssh.ensureKey;
          const endpoint = yield* boat.authorizeSshKey(key, machine.sandboxId, publicKey);
          const { changed } = yield* ssh.writeHost(alias, endpoint);
          if (changed) yield* invalidate(alias, "endpoint");
          // Only an explicit action pushes the auto-stop deadline out.
          if (options.wake)
            yield* boat.update(key, machine.sandboxId, { ttlSeconds: machine.ttlSeconds });
          const now = yield* Clock.currentTimeMillis;
          readyAt.set(alias, now);
          if (options.wake) wakeGenerations.set(alias, (wakeGenerations.get(alias) ?? 0) + 1);
          lastErrors.delete(alias);
          yield* Effect.forEach(readyListeners, (listener) => listener(alias), { discard: true });
          return { alias, endpointChanged: changed };
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              readyAt.delete(alias);
              lastErrors.set(alias, error.reason);
            }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("CloudMachineService.ensureReady", { attributes: { alias } }));

  const list = () =>
    Effect.gen(function* () {
      const configured = yield* isConfigured;
      const catalog = yield* readCatalog;
      const unconfirmedCreates = catalog.pendingCreates.length;
      if (!configured)
        return {
          configured,
          unconfirmedCreates,
          machines: catalog.machines.map((machine) => view(machine, { presence: "unknown" })),
        };
      const key = yield* apiKey;
      const entries = yield* Effect.forEach(
        catalog.machines,
        (machine) => remoteOf(key, machine).pipe(Effect.map((remote) => ({ machine, remote }))),
        { concurrency: 4 },
      );
      // A delete Boat accepted is final once Boat no longer shows the machine.
      const gone = entries.filter(
        ({ machine, remote }) => machine.deletePending && remote.presence === "not_found",
      );
      if (gone.length > 0) {
        const ids = new Set(gone.map(({ machine }) => machine.sandboxId));
        yield* updateCatalog((current) => [
          { ...current, machines: current.machines.filter((entry) => !ids.has(entry.sandboxId)) },
          undefined,
        ]);
      }
      return {
        configured,
        unconfirmedCreates,
        machines: entries
          .filter(
            ({ machine }) => !gone.some((entry) => entry.machine.sandboxId === machine.sandboxId),
          )
          .map(({ machine, remote }) => view(machine, remote)),
      };
    });

  const configure = (input: CloudMachinesConfigureInput) =>
    Effect.gen(function* () {
      yield* boat.checkKey(input.apiKey);
      yield* ssh.installInclude;
      yield* secrets
        .set(BOAT_API_KEY_SECRET, new TextEncoder().encode(input.apiKey))
        .pipe(Effect.mapError(() => fail("storage_failed")));
      readyAt.clear();
      return { configured: true as const };
    });

  const disconnect = () =>
    Effect.gen(function* () {
      yield* secrets
        .remove(BOAT_API_KEY_SECRET)
        .pipe(Effect.mapError(() => fail("storage_failed")));
      const catalog = yield* readCatalog;
      for (const machine of catalog.machines) {
        yield* ssh.removeHost(machine.alias);
        yield* invalidate(machine.alias, "lifecycle");
      }
      return { configured: false as const };
    });

  const create = (input: CloudMachinesCreateInput) =>
    Effect.gen(function* () {
      const key = yield* apiKey;
      yield* resolvePendingCreates(key);
      const pending: PendingCreate = {
        idempotencyKey: yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(() => fail("storage_failed"))),
        label: input.label,
        type: input.type,
        ttlSeconds: input.ttlSeconds,
        requestedAt: yield* Clock.currentTimeMillis,
      };
      yield* updateCatalog((catalog) => [
        { ...catalog, pendingCreates: [...catalog.pendingCreates, pending] },
        undefined,
      ]);
      const { machine, sandbox } = yield* sendCreate(key, pending);
      yield* nameMachine(key, machine);
      // SSH is set up by the first explicit use (Connect, browse, launch), which waits for Boat.
      return view(machine, { presence: "present", state: sandbox.state });
    });

  const stop = (alias: CloudMachineAlias) =>
    Effect.gen(function* () {
      const machine = yield* owned(alias);
      const key = yield* apiKey;
      yield* boat.stop(key, machine.sandboxId);
      yield* invalidate(alias, "lifecycle");
      return view(machine, yield* remoteOf(key, machine));
    });

  const resume = (alias: CloudMachineAlias) =>
    Effect.gen(function* () {
      const machine = yield* owned(alias);
      yield* ensureReady(alias, { wake: true });
      return view(machine, yield* remoteOf(yield* apiKey, machine));
    });

  const remove = (alias: CloudMachineAlias) =>
    Effect.gen(function* () {
      const machine = yield* owned(alias);
      const key = yield* apiKey;
      yield* boat.remove(key, machine.sandboxId);
      const pending = { ...machine, deletePending: true };
      yield* updateCatalog((catalog) => [
        {
          ...catalog,
          machines: catalog.machines.map((entry) => (entry.alias === alias ? pending : entry)),
        },
        undefined,
      ]);
      yield* ssh.removeHost(alias);
      yield* invalidate(alias, "lifecycle");
      return view(pending, yield* remoteOf(key, pending));
    });

  const forget = (alias: CloudMachineAlias) =>
    Effect.gen(function* () {
      const machine = yield* owned(alias);
      const key = yield* apiKey;
      const remote = yield* remoteOf(key, machine);
      const removable =
        remote.presence === "not_found" ||
        (remote.presence === "present" && remote.state === "archived");
      if (!removable) return yield* fail("forget_refused");
      yield* updateCatalog((catalog) => [
        { ...catalog, machines: catalog.machines.filter((entry) => entry.alias !== alias) },
        undefined,
      ]);
      yield* ssh.removeHost(alias);
      yield* invalidate(alias, "lifecycle");
      lastErrors.delete(alias);
      return { forgotten: true as const };
    });

  return CloudMachineService.of({
    changes: Stream.fromPubSub(signals),
    catalog: readCatalog.pipe(
      Effect.map((catalog) =>
        catalog.machines.map(({ alias, label, sandboxId }) => ({
          alias,
          label: label || sandboxId,
        })),
      ),
    ),
    list,
    configure,
    disconnect,
    create,
    stop,
    resume,
    delete: remove,
    forget,
    dismissUnconfirmedCreates: () =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          updateCatalog((catalog) => {
            const kept = catalog.pendingCreates.filter(
              (pending) => now - pending.requestedAt <= PENDING_CREATE_MAX_AGE_MS,
            );
            const dismissed = catalog.pendingCreates.length - kept.length;
            return [
              dismissed === 0 ? catalog : { ...catalog, pendingCreates: kept },
              { dismissed },
            ];
          }),
        ),
      ),
    ensureReady,
    owns: (alias) =>
      readCatalog.pipe(
        Effect.map((catalog) => catalog.machines.some((entry) => entry.alias === alias)),
        Effect.orElseSucceed(() => false),
      ),
    onAliasInvalidated: (listener) => Effect.sync(() => void listeners.push(listener)),
    onReady: (listener) => Effect.sync(() => void readyListeners.push(listener)),
  });
});

export const layerWithoutDependencies = Layer.effect(CloudMachineService, make);

/**
 * Machines this server manages that SSH config does not name yet: their first use readies them
 * and writes the entry, so host lists show them before it exists. Never probed, because reaching
 * one means readying it in Boat.
 */
export const unconfiguredHosts = (
  cloud: Option.Option<CloudMachineService["Service"]>,
  configured: ReadonlyArray<{ readonly alias: string }>,
) =>
  Option.isNone(cloud)
    ? Effect.succeed([])
    : cloud.value.catalog.pipe(
        Effect.orElseSucceed(() => []),
        Effect.map((machines) =>
          machines
            .filter((machine) => !configured.some((entry) => entry.alias === machine.alias))
            .map((machine) => ({ alias: machine.alias, source: "cloud-machine" as const })),
        ),
      );
