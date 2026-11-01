import type {
  HubNode,
  HubNodeAddedBy,
  HubNodeId,
  HubNodeNotice,
  HubNodesAddInput,
  HubNodesAddResult,
  HubNodesCheckInput,
  HubNodesImportInput,
  HubNodesImportResult,
  HubNodesRemoveInput,
  HubNodesRemoveResult,
  HubNodesSnapshot,
} from "@goat/contracts";
import {
  CLOUD_MACHINE_READY_STATES,
  ExecutionEnvironmentDescriptor,
  HubNodesError,
  SshHostAlias,
  hasCloudMachineAliasPrefix,
} from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HubNodeRepository from "./HubNodeRepository.ts";
import { mergeHubNodes } from "./merge.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export interface HubNodesAddOptions<E, R> {
  readonly addedBy: HubNodeAddedBy;
  /** Re-checks the caller right before the node is saved, after any slow remote exchange. */
  readonly beforeSave: Effect.Effect<void, E, R>;
  /** Refuse instead of saving a node whose environment id the hub cannot read yet. */
  readonly requireIdentity?: boolean;
}

/**
 * The hub's node list: registered SSH hosts merged with LinkedHosts and owned cloud machines,
 * one node per environment id. Transports (WebSocket RPC, MCP) call these methods only.
 */
export class HubNodes extends Context.Service<
  HubNodes,
  {
    readonly snapshot: Effect.Effect<HubNodesSnapshot, HubNodesError>;
    /** Current snapshot when readable, then distinct snapshots after coalesced source changes. */
    readonly changes: Stream.Stream<HubNodesSnapshot, HubNodesError>;
    readonly get: (nodeId: HubNodeId) => Effect.Effect<Option.Option<HubNode>, HubNodesError>;
    readonly add: <E, R>(
      input: HubNodesAddInput,
      options: HubNodesAddOptions<E, R>,
    ) => Effect.Effect<HubNodesAddResult, HubNodesError | E, R>;
    readonly remove: (
      input: HubNodesRemoveInput,
    ) => Effect.Effect<HubNodesRemoveResult, HubNodesError>;
    /** Probes routes without waking or extending a cloud machine. */
    readonly check: (input: HubNodesCheckInput) => Effect.Effect<HubNodesSnapshot, HubNodesError>;
    readonly importProfiles: (
      input: HubNodesImportInput,
    ) => Effect.Effect<HubNodesImportResult, HubNodesError>;
    readonly dismissNotice: (
      id: HubNodeNotice["id"],
    ) => Effect.Effect<{ readonly dismissed: boolean }, HubNodesError>;
  }
>()("goat/hubNodes/HubNodes") {}

const decodeAlias = Schema.decodeEffect(SshHostAlias);
const decodeDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);

function mapLinkedError(error: LinkedHosts.LinkedHostError): HubNodesError {
  return new HubNodesError({
    reason: error.reason === "link_refused" ? "refused" : error.reason,
    detail: "The hub could not complete the linked host operation.",
  });
}

export const make = Effect.gen(function* () {
  const repository = yield* HubNodeRepository.HubNodeRepository;
  const linked = yield* LinkedHosts.LinkedHosts;
  const cloud = yield* CloudMachineService.CloudMachineService;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const http = yield* HttpClient.HttpClient;
  const signals = yield* PubSub.sliding<void>(1);
  const lock = yield* Semaphore.make(1);
  // Orders cloud alias invalidation against check results, so a check that finishes after a
  // machine was forgotten cannot write its route state back.
  const routeStateLock = yield* Semaphore.make(1);
  // Bumped when a cloud machine is stopped, deleted, forgotten or disconnected, so a check that
  // read Boat before that cannot report the machine as it was.
  const cloudGenerations = new Map<string, number>();
  const publish = PubSub.publish(signals, undefined).pipe(Effect.asVoid);
  const now = Clock.currentTimeMillis.pipe(
    Effect.map((at) => DateTime.formatIso(DateTime.makeUnsafe(at))),
  );
  const snapshot = Effect.gen(function* () {
    const { environmentId: hubEnvironmentId } = yield* environment.getDescriptor;
    const registrations = yield* repository.listRegistrations;
    const routeState = yield* repository.listRouteState;
    const imported = yield* repository.getImport;
    const links = yield* linked.list.pipe(Effect.mapError(mapLinkedError));
    const catalog = yield* cloud.catalog.pipe(
      Effect.mapError(
        () =>
          new HubNodesError({
            reason: "storage_failed",
            detail: "This hub could not read its cloud machine catalog.",
          }),
      ),
    );
    return mergeHubNodes({
      hubEnvironmentId,
      registrations,
      linked: links,
      cloud: catalog,
      routeState,
      notices:
        imported?.outcome === "skipped_locked" && imported.noticeDismissedAt === null
          ? [{ id: "desktop-import-locked", at: imported.at }]
          : [],
    });
  });
  const get = (nodeId: HubNodeId) =>
    snapshot.pipe(
      Effect.map((current) =>
        Option.fromUndefinedOr(
          current.nodes.find(
            (node) =>
              node.nodeId === nodeId ||
              (nodeId.startsWith("route:") &&
                node.routes.some((route) => route.routeId === nodeId.slice(6))),
          ),
        ),
      ),
    );
  const requireNode = (nodeId: HubNodeId) =>
    get(nodeId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new HubNodesError({ reason: "not_found", detail: "This hub node no longer exists." }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  // A failed read emits nothing; the next invalidation retries for the same subscriber.
  const readForSubscriber = snapshot.pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Could not refresh hub node snapshot.", { reason: error.reason }),
    ),
    Effect.option,
  );
  const changes = Stream.unwrap(
    PubSub.subscribe(signals).pipe(
      Effect.map((subscription) =>
        Stream.concat(
          Stream.fromEffect(readForSubscriber),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => readForSubscriber)),
        ),
      ),
    ),
  ).pipe(
    Stream.filter(Option.isSome),
    Stream.map((value) => value.value),
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  );

  yield* linked.changes.pipe(
    Stream.runForEach(() => publish),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* cloud.changes.pipe(
    Stream.runForEach(() => publish),
    Effect.forkScoped({ startImmediately: true }),
  );
  let active = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active = false;
    }),
  );
  // A new address or host key belongs to the same running machine, often refreshed by this
  // hub's own check, so only a stop, disconnect or removal resets the route and voids checks.
  yield* cloud.onAliasInvalidated((alias, cause) =>
    Effect.suspend(() =>
      active && cause !== "endpoint"
        ? Effect.sync(() =>
            cloudGenerations.set(alias, (cloudGenerations.get(alias) ?? 0) + 1),
          ).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const routeId = `cloud:${alias}`;
                const catalog = yield* cloud.catalog;
                if (catalog.some((entry) => entry.alias === alias)) {
                  const previous = (yield* repository.listRouteState).find(
                    (row) => row.routeId === routeId,
                  );
                  yield* repository.upsertRouteState({
                    routeId,
                    environmentId: previous?.environmentId ?? null,
                    status: "unknown",
                    checkedAt: null,
                    lastSeenAt: previous?.lastSeenAt ?? null,
                    lastError: null,
                  });
                } else {
                  yield* repository.deleteRouteState(routeId);
                }
                yield* publish;
              }).pipe(routeStateLock.withPermits(1)),
            ),
            Effect.ignore,
          )
        : Effect.void,
    ),
  );

  const add: HubNodes["Service"]["add"] = Effect.fn("HubNodes.add")(function* (input, options) {
    const before = yield* snapshot;
    if (input.kind === "linked") {
      const result = yield* linked
        .link({
          name: input.name,
          url: input.url,
          ...(input.code === undefined ? {} : { code: input.code }),
          access: input.access,
          clientName: "GOAT hub",
          label: input.label,
          beforeSave: options.beforeSave,
          acceptDescriptor: (descriptor) =>
            descriptor.environmentId === before.hubEnvironmentId
              ? Effect.fail(
                  new HubNodesError({
                    reason: "refused",
                    detail: "The hub cannot add itself as a node.",
                  }),
                )
              : Effect.void,
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof LinkedHosts.LinkedHostError ? mapLinkedError(error) : error,
          ),
        );
      // A replaced link must not inherit the previous host's check or learned identity.
      yield* repository.deleteRouteState(`linked:${result.host.name}`);
      yield* publish;
      const node = (yield* snapshot).nodes.find((entry) =>
        entry.routes.some((route) => route.routeId === `linked:${result.host.name}`),
      );
      if (!node)
        return yield* new HubNodesError({
          reason: "refused",
          detail: "The hub cannot add itself as a node.",
        });
      return { created: !before.nodes.some((entry) => entry.nodeId === node.nodeId), node };
    }
    const alias = yield* decodeAlias(input.alias).pipe(
      Effect.mapError(
        () =>
          new HubNodesError({ reason: "invalid_request", detail: "Pass a valid SSH host alias." }),
      ),
    );
    if (hasCloudMachineAliasPrefix(alias))
      return yield* new HubNodesError({
        reason: "refused",
        detail: "Cloud machine aliases are managed in Settings → Connections → Cloud machines.",
      });
    const target = { alias, hostname: input.hostname, username: input.username, port: input.port };
    const identity = yield* ssh
      .identifyTarget({ ...target, hostname: target.hostname ?? alias })
      .pipe(
        Effect.mapError(
          () =>
            new HubNodesError({ reason: "host_unavailable", detail: `Could not reach ${alias}.` }),
        ),
      );
    if (identity === before.hubEnvironmentId)
      return yield* new HubNodesError({
        reason: "refused",
        detail: "The hub cannot add itself as a node.",
      });
    if (identity === null && options.requireIdentity)
      return yield* new HubNodesError({
        reason: "invalid_request",
        detail: `GOAT has not run on ${alias} yet; run goat_ssh_host_prepare first`,
      });
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const routeId = `ssh:${alias}`;
        const current = yield* snapshot;
        const previous = (yield* repository.listRegistrations).find(
          (row) => row.routeId === routeId,
        );
        const at = yield* now;
        yield* repository.transaction(
          Effect.gen(function* () {
            yield* options.beforeSave;
            yield* repository.upsertRegistration({
              routeId,
              environmentId: identity,
              label: input.label ?? previous?.label ?? null,
              target: { kind: "ssh", ...target },
              addedBy: previous?.addedBy ?? options.addedBy,
              createdAt: previous?.createdAt ?? at,
              updatedAt: at,
            });
            yield* repository.upsertRouteState({
              routeId,
              environmentId: identity,
              status: "online",
              checkedAt: at,
              lastSeenAt: at,
              lastError: null,
            });
          }),
        );
        yield* publish;
        const node = yield* requireNode(`route:${routeId}`);
        return {
          created:
            previous === undefined && !current.nodes.some((entry) => entry.nodeId === node.nodeId),
          node,
        };
      }),
    );
  });

  const remove: HubNodes["Service"]["remove"] = Effect.fn("HubNodes.remove")(function* (input) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const node = yield* requireNode(input.nodeId);
        const routes =
          input.routeId === undefined
            ? node.routes
            : node.routes.filter((route) => route.routeId === input.routeId);
        if (routes.length === 0)
          return yield* new HubNodesError({
            reason: "not_found",
            detail: "This route no longer belongs to the node.",
          });
        if (routes.some((route) => route.target.kind === "cloud"))
          return yield* new HubNodesError({
            reason: "refused",
            detail: "Manage cloud machines in Settings → Connections → Cloud machines.",
          });
        for (const route of routes) {
          if (route.target.kind === "linked")
            yield* linked.unlink(route.target.name).pipe(Effect.mapError(mapLinkedError));
          yield* repository.transaction(
            Effect.gen(function* () {
              if (route.source === "registered")
                yield* repository.deleteRegistration(route.routeId);
              yield* repository.deleteRouteState(route.routeId);
            }),
          );
        }
        yield* publish;
        return { removed: node };
      }),
    );
  });

  const check: HubNodes["Service"]["check"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const generations = new Map(cloudGenerations);
        const current = yield* snapshot;
        const nodes =
          input.nodeId === undefined ? current.nodes : [yield* requireNode(input.nodeId)];
        const routes = nodes.flatMap((node) => node.routes);
        const identities = new Map(
          nodes.flatMap((node) =>
            node.routes.map((route) => [route.routeId, node.environmentId] as const),
          ),
        );
        const cloudResult = routes.some((route) => route.target.kind === "cloud")
          ? yield* cloud.list().pipe(Effect.timeout("15 seconds"), Effect.result)
          : null;
        const states = new Map((yield* repository.listRouteState).map((row) => [row.routeId, row]));
        yield* Effect.forEach(
          routes,
          (route) =>
            Effect.gen(function* () {
              const result = yield* Effect.gen(function* () {
                const target = route.target;
                if (target.kind === "linked") {
                  const response = yield* http
                    .execute(
                      HttpClientRequest.get(
                        new URL(GOAT_ENVIRONMENT_PATH, target.baseUrl).toString(),
                      ),
                    )
                    .pipe(
                      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
                      Effect.provideService(FetchHttpClient.RequestInit, {
                        redirect: "manual",
                        credentials: "omit",
                        cache: "no-store",
                      }),
                    );
                  if (response.status < 200 || response.status >= 300)
                    return yield* new HubNodesError({
                      reason: "host_unavailable",
                      detail: "The linked host did not answer its environment descriptor.",
                    });
                  return yield* response.json.pipe(
                    Effect.flatMap(decodeDescriptor),
                    Effect.map((descriptor) => descriptor.environmentId),
                  );
                }
                if (target.kind === "cloud") {
                  const machine =
                    cloudResult?._tag === "Success"
                      ? cloudResult.success.machines.find((entry) => entry.alias === target.alias)
                      : undefined;
                  if (
                    machine?.presence !== "present" ||
                    machine.state === null ||
                    !CLOUD_MACHINE_READY_STATES.has(machine.state)
                  )
                    return yield* new HubNodesError({
                      reason: "host_unavailable",
                      detail: "The cloud machine is not running or available.",
                    });
                  return yield* ssh.identifyTarget({
                    alias: target.alias,
                    hostname: target.alias,
                    username: null,
                    port: null,
                  });
                }
                return yield* ssh.identifyTarget({
                  ...target,
                  hostname: target.hostname ?? target.alias,
                });
              }).pipe(Effect.timeout("15 seconds"), Effect.result);
              const at = yield* now;
              const previous = states.get(route.routeId);
              const target = route.target;
              yield* Effect.gen(function* () {
                if (
                  target.kind === "cloud" &&
                  (cloudGenerations.get(target.alias) !== generations.get(target.alias) ||
                    !(yield* cloud.catalog.pipe(
                      Effect.orElseSucceed((): ReadonlyArray<{ readonly alias: string }> => []),
                    )).some((entry) => entry.alias === target.alias))
                )
                  return;
                yield* repository.upsertRouteState({
                  routeId: route.routeId,
                  environmentId:
                    result._tag === "Success"
                      ? (result.success ??
                        previous?.environmentId ??
                        identities.get(route.routeId) ??
                        null)
                      : (previous?.environmentId ?? identities.get(route.routeId) ?? null),
                  status: result._tag === "Success" ? "online" : "offline",
                  checkedAt: at,
                  lastSeenAt: result._tag === "Success" ? at : (previous?.lastSeenAt ?? null),
                  lastError:
                    result._tag === "Success"
                      ? null
                      : "The route did not answer a read-only check.",
                });
              }).pipe(routeStateLock.withPermits(1));
            }),
          { concurrency: 4, discard: true },
        );
        yield* publish;
        return yield* snapshot;
      }),
    );

  const importProfiles: HubNodes["Service"]["importProfiles"] = Effect.fn(
    "HubNodes.importProfiles",
  )(function* (input) {
    const result = yield* repository.transaction(
      Effect.gen(function* () {
        const previous = yield* repository.getImport;
        if (previous?.outcome === "imported")
          return { outcome: "already_imported" as const, imported: 0 };
        const at = yield* now;
        if (input.catalog.state === "locked") {
          if (!previous)
            yield* repository.putImport({
              source: input.source,
              outcome: "skipped_locked",
              imported: 0,
              at,
              noticeDismissedAt: null,
            });
          return { outcome: "skipped_locked" as const, imported: 0 };
        }
        const existing = new Set((yield* repository.listRegistrations).map((row) => row.routeId));
        let imported = 0;
        for (const profile of input.catalog.profiles) {
          const alias = profile.ssh.alias;
          const routeId = `ssh:${alias}`;
          if (hasCloudMachineAliasPrefix(alias) || existing.has(routeId)) continue;
          yield* repository.upsertRegistration({
            routeId,
            environmentId: profile.environmentId,
            label: profile.label,
            target: { kind: "ssh", ...profile.ssh },
            addedBy: { kind: "import", at },
            createdAt: at,
            updatedAt: at,
          });
          yield* repository.upsertRouteState({
            routeId,
            environmentId: profile.environmentId,
            status: "unknown",
            checkedAt: null,
            lastSeenAt: null,
            lastError: null,
          });
          existing.add(routeId);
          imported++;
        }
        yield* repository.putImport({
          source: input.source,
          outcome: "imported",
          imported,
          at,
          noticeDismissedAt: null,
        });
        return { outcome: "imported" as const, imported };
      }),
    );
    yield* publish;
    return result;
  });
  const dismissNotice: HubNodes["Service"]["dismissNotice"] = Effect.fn("HubNodes.dismissNotice")(
    function* () {
      const dismissed = yield* repository.dismissImportNotice(yield* now);
      yield* publish;
      return { dismissed };
    },
  );
  return HubNodes.of({ snapshot, changes, get, add, remove, check, importProfiles, dismissNotice });
});

export const layer = Layer.effect(HubNodes, make);
