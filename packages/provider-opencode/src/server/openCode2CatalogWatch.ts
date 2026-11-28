import type { ServerProvider } from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { OpenCodeSettings } from "../settings.ts";
import type * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { loadOpenCode2DirectoryCatalog } from "./openCode2Catalog.ts";
import {
  catalogFingerprint,
  openCode2ProviderModels,
  openCode2ReadyMessage,
  readSettledOpenCode2Catalog,
  type OpenCode2Model,
} from "./status.ts";
import type * as OpenCode2Server from "./v2/OpenCode2Server.ts";

// The registry keeps this many per-directory snapshots; older directories need no watch.
const WATCHED_DIRECTORIES = 16;

interface WatchedCatalog {
  readonly read: Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError>;
  previous: string | undefined;
}

/**
 * OpenCode serves a startup snapshot until discovery ends and only `model.updated` says when, so
 * no wait proves a catalog complete. The watch re-reads after each followed read and each change
 * while the server's event stream lasts, borrowing nothing so a managed server still idles out.
 */
export const makeOpenCode2CatalogWatch = Effect.fn(
  "OpencodeProviderStatus.makeOpenCode2CatalogWatch",
)(function* (environment?: NodeJS.ProcessEnv | Effect.Effect<NodeJS.ProcessEnv>) {
  const scope = yield* Effect.scope;
  const resolveEnvironment: Effect.Effect<NodeJS.ProcessEnv | null> =
    environment === undefined
      ? Effect.succeed(null)
      : Effect.isEffect(environment)
        ? environment
        : Effect.succeed(environment);
  const latest = yield* SubscriptionRef.make<ReadonlyArray<OpenCode2Model> | undefined>(undefined);
  const rescans = yield* Queue.unbounded<string, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.end(rescans));
  const reads = yield* Queue.sliding<void>(1);
  let following:
    | {
        readonly server: string;
        machine: WatchedCatalog | undefined;
        readonly directories: Map<string, WatchedCatalog>;
      }
    | undefined;
  const reread = (
    watched: WatchedCatalog,
    changed: (catalog: ReadonlyArray<OpenCode2Model>) => Effect.Effect<unknown>,
    read: Effect.Effect<
      ReadonlyArray<OpenCode2Model>,
      OpenCodeRuntime.OpenCodeRuntimeError
    > = watched.read,
  ) =>
    read.pipe(
      Effect.flatMap((catalog) => {
        const fingerprint = catalog.length > 0 ? catalogFingerprint(catalog) : undefined;
        if (fingerprint === undefined || fingerprint === watched.previous) return Effect.void;
        watched.previous = fingerprint;
        return changed(catalog);
      }),
      // A stopped server fails every read; that must not discard the catalog it had listed.
      Effect.retry({ times: 3, schedule: Schedule.spaced("1 second") }),
      // Nothing else bounds this read, and one that hangs would hold every later change.
      Effect.timeout("30 seconds"),
      Effect.ignore,
    );
  return {
    /** The newest machine catalog the watch read; undefined when the last check knows better. */
    changes: SubscriptionRef.changes(latest),
    /** Directories whose catalog no longer matches the one their scan was given. */
    rescans: Stream.fromQueue(rescans),
    /**
     * Call beside each catalog read. `read` must not borrow the server. A `directory` read
     * reports the catalog its scan settled on, if any, and is rescanned once that changes.
     */
    follow: <E, SE>(
      server: string,
      subscribe: Effect.Effect<Stream.Stream<{ readonly type: string }, SE>, E, Scope.Scope>,
      read: Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError>,
      directory?: { readonly cwd: string; readonly settled?: ReadonlyArray<OpenCode2Model> },
    ) =>
      Effect.suspend(() => {
        const started = following === undefined || following.server !== server;
        const watching =
          following !== undefined && following.server === server
            ? following
            : { server, machine: undefined, directories: new Map<string, WatchedCatalog>() };
        following = watching;
        if (directory === undefined) {
          watching.machine = { read, previous: watching.machine?.previous };
        } else {
          const { cwd, settled } = directory;
          const previous = settled?.length
            ? catalogFingerprint(settled)
            : watching.directories.get(cwd)?.previous;
          watching.directories.delete(cwd);
          watching.directories.set(cwd, { read, previous });
          for (const oldest of watching.directories.keys()) {
            if (watching.directories.size <= WATCHED_DIRECTORIES) break;
            watching.directories.delete(oldest);
          }
        }
        const requested = Queue.offer(reads, undefined).pipe(Effect.asVoid);
        if (!started) return requested;
        const rereadAll = Effect.suspend(() =>
          Effect.forEach(
            [
              ...(watching.machine
                ? [reread(watching.machine, (catalog) => SubscriptionRef.set(latest, catalog))]
                : []),
              ...Array.from(watching.directories, ([cwd, watched]) =>
                reread(watched, () => Queue.offer(rescans, cwd)),
              ),
            ],
            (effect) => effect,
            { concurrency: 4, discard: true },
          ),
        );
        // A new server lists its startup snapshot first; nothing else reads it unless a check did.
        const settleMachine = Effect.suspend(() => {
          const machine = watching.machine;
          return machine === undefined
            ? Effect.void
            : resolveEnvironment.pipe(
                Effect.flatMap((env) =>
                  reread(
                    machine,
                    (catalog) => SubscriptionRef.set(latest, catalog),
                    readSettledOpenCode2Catalog(machine.read, env ?? undefined).pipe(
                      Effect.map(Option.getOrElse((): ReadonlyArray<OpenCode2Model> => [])),
                    ),
                  ),
                ),
              );
        });
        const watch = subscribe.pipe(
          Effect.tap(() => settleMachine),
          Effect.flatMap((events) =>
            events.pipe(
              Stream.filter((event) => event.type === "model.updated"),
              Stream.merge(Stream.fromQueue(reads), { haltStrategy: "left" }),
              // OpenCode announces one change as a burst of events.
              Stream.debounce("250 millis"),
              Stream.runForEach(() => rereadAll),
              Effect.ignore,
            ),
          ),
          // Unwatched, a catalog kept from an earlier server would override every later check.
          Effect.catch(() => SubscriptionRef.set(latest, undefined)),
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              if (following === watching) following = undefined;
            }),
          ),
        );
        return requested.pipe(Effect.andThen(Effect.forkIn(watch, scope)), Effect.asVoid);
      }),
  };
});

/** A catalog read after the check reports the same health the check would have. */
const withOpenCode2Catalog = (
  snapshot: ServerProvider,
  settings: Pick<OpenCodeSettings, "customModels">,
  catalog: ReadonlyArray<OpenCode2Model>,
): ServerProvider =>
  snapshot.version === null || snapshot.status === "error" || snapshot.status === "disabled"
    ? snapshot
    : {
        ...snapshot,
        status: "ready",
        auth: { ...snapshot.auth, status: "authenticated" },
        message: openCode2ReadyMessage(snapshot.version, catalog.length),
        models: openCode2ProviderModels(settings, catalog),
      };

export const enrichOpenCode2Snapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly settings: Pick<OpenCodeSettings, "customModels">;
  readonly catalogChanges: Stream.Stream<ReadonlyArray<OpenCode2Model> | undefined>;
  readonly enrichAdvisory: Effect.Effect<ServerProvider>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> => {
  let enriched = input.snapshot;
  let catalog: ReadonlyArray<OpenCode2Model> | undefined;
  // Each publication replaces the whole snapshot, so both sources publish their combination.
  const publishing = Semaphore.makeUnsafe(1);
  const publish = publishing.withPermit(
    Effect.suspend(() =>
      input.publishSnapshot(
        catalog === undefined ? enriched : withOpenCode2Catalog(enriched, input.settings, catalog),
      ),
    ),
  );
  return Effect.all(
    [
      input.enrichAdvisory.pipe(
        Effect.flatMap((enrichedSnapshot) => {
          enriched = enrichedSnapshot;
          return publish;
        }),
      ),
      Stream.runForEach(input.catalogChanges, (listed) => {
        catalog = listed;
        return publish;
      }),
    ],
    { concurrency: "unbounded", discard: true },
  );
};

export const makeOpenCode2MachineCatalogFollower = (
  catalogWatch: Pick<Effect.Success<ReturnType<typeof makeOpenCode2CatalogWatch>>, "follow">,
  hostCwd: string,
) => {
  // An external server may not have the host's cwd; without a location it uses its own default.
  const machineDirectory = (connection: OpenCode2Server.OpenCode2Connection) =>
    connection.external ? undefined : hostCwd;
  return {
    machineDirectory,
    follow: (connection: OpenCode2Server.OpenCode2Connection) =>
      catalogWatch.follow(
        connection.url,
        connection.events,
        loadOpenCode2DirectoryCatalog(connection.client, machineDirectory(connection)),
      ),
  };
};
