import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Client from "./MemoryHubClient.ts";
import * as Owner from "./MemoryOwnerSourceReader.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";

const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const owner = yield* Owner.MemoryOwnerSourceReader;
  const settings = yield* Settings.MemoryHubCommittedSettings;
  const store = yield* Store.MemoryStore;
  const registry = yield* Registry.ProviderInstanceRegistry;
  const quota = yield* Quota.MemoryQuotaService;
  const environmentId = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const client = yield* Client.MemoryHubClient;
  type Observation = {
    epoch: number;
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
    holdClass: Store.MemoryHoldClass;
  };
  const events = yield* PubSub.dropping<Observation>(16);
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  // One observed epoch and four failure classes.
  // Never retain credential bytes, response bodies or a per-request history.
  let epoch: number | null = null;
  const failures = new Set<Store.MemoryHoldClass>();
  const publish = (connection: Client.HubConnection, holdClass: Store.MemoryHoldClass) =>
    connection.memorySpaceId === null
      ? Effect.void
      : PubSub.publish(events, {
          epoch: connection.epoch,
          memorySpaceId: connection.memorySpaceId,
          hubEnvironmentId: connection.hubEnvironmentId,
          holdClass,
        });
  const observe = <A>(
    connection: Client.HubConnection,
    effect: Effect.Effect<A, Client.HubClientFailure>,
    authenticated = true,
  ) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(effect);
      const current = yield* settings.read;
      if (
        current.version === connection.epoch &&
        current.settings.mode === "member" &&
        current.settings.memorySpaceId === connection.memorySpaceId
      ) {
        if (epoch !== connection.epoch) {
          failures.clear();
          epoch = connection.epoch;
          // Committed binding changes are handled by Sync's settings consumer.
          // This adapter publishes only recovery observed on this transport.
        }
        if (result._tag === "Failure") {
          const error = result.failure;
          failures.add(
            error._tag !== "MemoryHubError" || error.code === "route_unavailable"
              ? "authorization"
              : error.code === "identity_mismatch" || error.code === "space_mismatch"
                ? "identity"
                : error.code === "unsupported_protocol" ||
                    error.code === "invalid_output" ||
                    error.code === "invalid_cursor" ||
                    error.code === "unsupported_operation"
                  ? "protocol"
                  : "availability",
          );
        } else {
          for (const holdClass of failures) {
            if (!authenticated) {
              // The Sync recovery probe validates the pinned descriptor and owns
              // its rearm. Do not publish the same observation a second time.
              if (holdClass !== "authorization") failures.delete(holdClass);
              continue;
            }
            yield* publish(connection, holdClass);
            failures.delete(holdClass);
          }
        }
      }
      return result._tag === "Success" ? result.success : yield* result.failure;
    });
  const observed = Client.MemoryHubClient.of({
    ...client,
    preflight: (connection) => observe(connection, client.preflight(connection), false),
    join: (c, i) => observe(c, client.join(c, i)),
    push: (c, i) => observe(c, client.push(c, i)),
    pull: (c, i) => observe(c, client.pull(c, i)),
    claim: (c, i) => observe(c, client.claim(c, i)),
    renew: (c, i) => observe(c, client.renew(c, i)),
    applyResolution: (c, i) => observe(c, client.applyResolution(c, i)),
    release: (c, i) => observe(c, client.release(c, i)),
    requestSourceRead: (c, i) => observe(c, client.requestSourceRead(c, i)),
    collectSourceReads: (c, i) => observe(c, client.collectSourceReads(c, i)),
    respondSourceRead: (c, i, prepare) => observe(c, client.respondSourceRead(c, i, prepare)),
    resultSourceRead: (c, i) => observe(c, client.resultSourceRead(c, i)),
  });
  const runtime = Sync.MemorySyncRuntime.of({
    cwd: config.cwd,
    readIntentBinding: settings.read.pipe(
      Effect.map((view) => ({
        memorySpaceId: view.settings.mode === "disabled" ? null : view.settings.memorySpaceId,
        coordinatorEpoch: view.version,
        enabled: view.settings.mode !== "disabled",
      })),
    ),
    rearmEvents: Stream.fromPubSub(events).pipe(
      Stream.filterEffect((event) =>
        settings.read.pipe(
          Effect.map(
            (view) =>
              view.version === event.epoch &&
              view.settings.mode !== "disabled" &&
              view.settings.memorySpaceId === event.memorySpaceId &&
              (view.settings.mode === "hub" ? environmentId : view.settings.hubEnvironmentId) ===
                event.hubEnvironmentId,
          ),
        ),
      ),
    ),
    readBootstrap: (memorySpaceId, hubEnvironmentId) =>
      store.readBootstrap({ memorySpaceId, hubEnvironmentId }),
    discardBootstrap: (memorySpaceId, hubEnvironmentId, token) =>
      store.transact(
        Effect.gen(function* () {
          const progress = yield* store.readBootstrap({ memorySpaceId, hubEnvironmentId });
          if (
            progress.state !== "staging" ||
            progress.snapshotToken !== token ||
            progress.checkpointId === null
          )
            return;
          yield* store.discardBootstrapTx({
            memorySpaceId,
            hubEnvironmentId,
            expectedSnapshotToken: token,
            expectedCheckpointId: progress.checkpointId,
            expectedCheckpointSequence: progress.checkpointSequence,
          });
        }),
      ),
    readProcessing: (memorySpaceId, hubEnvironmentId) =>
      store.readLocalProcessingStatus({ environmentId, memorySpaceId, hubEnvironmentId }),
    readUnboundStorage: quota.readUnboundStorageStatus({ environmentId }),
    available: (selection) =>
      registry
        .getInstance(selection.instanceId)
        .pipe(
          Effect.flatMap((instance) =>
            instance === undefined || !instance.enabled
              ? Effect.fail(new M.MemoryHubError({ code: "route_unavailable" }))
              : instance.textGeneration.resolveMemoryConflict === undefined
                ? Effect.fail(new M.MemoryHubError({ code: "unsupported_operation" }))
                : Effect.void,
          ),
        ),
    ...(owner.policy ? { ownerPolicy: owner.policy } : {}),
    ownerPermit: owner.permit,
    ownerReader: owner.reader,
  });
  return Layer.mergeAll(
    Layer.succeed(Sync.MemorySyncRuntime, runtime),
    Layer.succeed(Client.MemoryHubClient, observed),
  );
});

/** The raw Client is constructed once; consumers receive only its observed boundary. */
export const layer = Layer.unwrap(make).pipe(
  Layer.provide(Layer.mergeAll(Client.layer, Owner.layer)),
);
