import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  GoatHostStatusResult,
  OrchestratorMcpFailure,
  type EnvironmentId,
  type GoatHostStatusInput,
  type HostStatusEntry,
  type ProviderInstanceId,
} from "@goat/contracts";
import { resolveServerBackgroundActivitySettings } from "@goat/shared/backgroundActivitySettings";
import * as HostProcess from "@goat/shared/HostProcess";
import { servedRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as CuaDriver from "../cua/CuaDriver.ts";
import * as ServerBrowserReadiness from "../preview/serverBrowserReadiness.ts";
import * as StrayProcesses from "../diagnostics/StrayProcesses.ts";
import * as FleetSync from "../goatclaw/FleetSync.ts";
import * as HostPressureMonitor from "../fleet/pressure/HostPressureMonitor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OpenCodexInventory from "../opencodex/OpenCodexInventory.ts";
import * as OpenCodexChildBootstrap from "../opencodex/OpenCodexChildBootstrap.ts";
import * as HubParity from "../hub/HubParity.ts";
import * as OpenCodexManagedUpdate from "../hub/OpenCodexManagedUpdate.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as RepositoryInventory from "../project/RepositoryInventory.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { PlacementAdmissionEnabled } from "../fleet/admission/PlacementKey.ts";
import {
  countHostThreads,
  runningSubagents,
  hostStatusProviders,
  hostStatusQuotas,
  isUnsupportedHostStatusMessage,
  LOCAL_HOST_COMPATIBILITY,
  markHostCompatibility,
  omitUnencodableMetrics,
  quotaRefreshDue,
  tagRemoteHostStatus,
  unreachableHostStatus,
  unsupportedHostStatus,
} from "./hostStatusModel.ts";

/**
 * Shorter than the thread tools' remote deadline, and it covers connecting as well as the call:
 * a host still setting up SSH is unreachable for this answer and its previous sample, when there
 * is one, stands in.
 */
export const HOST_STATUS_REMOTE_TIMEOUT_MS = 10_000;

/** How long a shared read answers from a host's last ok status instead of asking it again. */
const REMOTE_STATUS_FRESH_MS = 30_000;

const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);

/** One host read in flight; every caller sharing its key awaits the same answer. */
type PendingRead = Deferred.Deferred<HostStatusEntry, OrchestratorMcpFailure>;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** These describe the caller, not one host, so they fail the whole call. */
const callerFailure = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "parent_not_active" ||
  error.code === "runtime_mode_escalation_denied" ||
  error.code === "interaction_mode_escalation_denied";

export interface HostStatusMcpServiceShape {
  readonly read: (
    scope: McpInvocationScope,
    input: GoatHostStatusInput,
    options?: {
      /** Repository diagnosis must not acquire a stopped runtime; ordinary status keeps its existing behavior. */
      readonly requireReady?: true;
      /**
       * For callers already authorized for every connected host (signed-in clients, placement,
       * pressure, health): they join one read per host and reuse an answer under 30 s old.
       */
      readonly shared?: true;
    },
  ) => Effect.Effect<GoatHostStatusResult, OrchestratorMcpFailure>;
  /**
   * The same read for a signed-in client. Connected SSH hosts are reached only with `reachHosts`,
   * which uses this machine's SSH keys. Without it, or with `local`, only this machine is read.
   */
  readonly readForClient: (client: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly reachHosts: boolean;
    readonly local?: boolean;
  }) => Effect.Effect<GoatHostStatusResult, OrchestratorMcpFailure>;
}

export class HostStatusMcpService extends Context.Service<
  HostStatusMcpService,
  HostStatusMcpServiceShape
>()("goat/mcp/HostStatusMcpService") {}

const make = Effect.gen(function* () {
  const resources = yield* HostResources.HostResources;
  const repositories = yield* RepositoryInventory.RepositoryInventory;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const usageSources = yield* UsageLimitSources.UsageLimitSources;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const layerScope = yield* Effect.scope;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Runtime updates wait on this predicate, so host status reports the same answer.
  const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const opencodex = yield* OpenCodexInventory.OpenCodexInventory;
  const parity = yield* HubParity.HubParity;
  // Optional so layers built for one tool need not schedule OpenCodex updates.
  const opencodexUpdate = yield* Effect.serviceOption(
    OpenCodexManagedUpdate.OpenCodexManagedUpdate,
  );
  // Optional so layers built for one tool need not run storage passes or process scans.
  const storage = yield* Effect.serviceOption(DatabaseStorage.DatabaseStorage);
  const strays = yield* Effect.serviceOption(StrayProcesses.StrayProcesses);
  const pressureMonitor = yield* Effect.serviceOption(HostPressureMonitor.HostPressureMonitor);
  const fleet = yield* Effect.serviceOption(FleetSync.GoatclawFleetSync);
  const childBootstrap = yield* Effect.serviceOption(
    OpenCodexChildBootstrap.OpenCodexChildBootstrap,
  );
  /** This machine's view of the host: whether its goatclaw policy reached it, and its Child setup. */
  const withGoatclaw = Effect.fn("HostStatus.withHostState")(function* (entry: HostStatusEntry) {
    if (entry.host === null) return entry;
    const goatclaw = Option.isSome(fleet) ? yield* fleet.value.hostState(entry.host) : undefined;
    // The switch first: reading it can record why the host's consent ended.
    const optIn = Option.isSome(childBootstrap)
      ? yield* childBootstrap.value.sshOptIn(entry.host)
      : undefined;
    const child = Option.isSome(childBootstrap)
      ? yield* childBootstrap.value.status(entry.host)
      : undefined;
    return {
      ...entry,
      ...(goatclaw === undefined ? {} : { goatclaw }),
      ...(child === undefined ? {} : { opencodexChild: child }),
      ...(optIn === undefined ? {} : { opencodexChildOptIn: optIn }),
    } satisfies HostStatusEntry;
  });
  const clock = yield* Clock.Clock;
  // Optional so tests and builds without the driver keep reporting the rest.
  const cua = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  const browserReadiness = yield* ServerBrowserReadiness.optionalReadiness;
  /** One background provider probe at a time; startedAt paces the next one. */
  const quotaProbe = yield* Ref.make({ running: false, startedAt: Number.NEGATIVE_INFINITY });
  const known = yield* Ref.make(new Map<string | null, HostStatusEntry>());
  /** Plain status from shared reads only, so an agent's wider read never answers a client. */
  const sharedAnswers = yield* Ref.make(
    new Map<string, { readonly entry: HostStatusEntry; readonly at: number }>(),
  );
  /** Per caller and host, so a slow host's connection keeps going between polls instead of restarting. */
  const remoteReads = yield* Ref.make(new Map<string, PendingRead>());

  const remember = (key: string | null, entry: HostStatusEntry) =>
    Ref.update(known, (current) => new Map(current).set(key, entry));

  const defaultQuotaPaceMs = Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL);
  /** Background activity's provider check interval; a read is demand, so "off" keeps the default. */
  const quotaPaceMs = settingsService.getSettings.pipe(
    Effect.map((settings) =>
      Duration.toMillis(
        resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
      ),
    ),
    Effect.map((ms) => (ms > 0 ? ms : defaultQuotaPaceMs)),
    Effect.orElseSucceed(() => defaultQuotaPaceMs),
  );

  const refreshQuotas = Effect.fn("HostStatus.refreshQuotas")(function* (
    instanceIds: ReadonlyArray<ProviderInstanceId>,
  ) {
    // One provider failing or dying must not stop the rest; its cached windows stay.
    yield* Effect.forEach(instanceIds, (id) => Effect.exit(registry.refreshInstance(id)), {
      concurrency: 1,
      discard: true,
    });
  });

  const readQuotas = Effect.fn("HostStatus.readQuotas")(function* () {
    const now = yield* clock.currentTimeMillis;
    const pace = yield* quotaPaceMs;
    const providers = yield* registry.getProviders;
    const due = providers.filter((provider) => quotaRefreshDue(provider.usageLimits, now, pace));
    if (due.length > 0) {
      // Placement, pressure and clients poll this, and a provider probe takes seconds: none of them waits on it.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const claimed = yield* Ref.modify(quotaProbe, (state) =>
            !state.running && now - state.startedAt >= pace
              ? [true, { running: true, startedAt: now }]
              : [false, state],
          );
          if (!claimed) return;
          yield* refreshQuotas(due.map((provider) => provider.instanceId)).pipe(
            Effect.ensuring(Ref.update(quotaProbe, (state) => ({ ...state, running: false }))),
            Effect.forkIn(layerScope),
          );
        }),
      );
    }
    const projected = yield* usageSources.projectProviders(providers);
    const quotaPool = yield* usageSources.quotaPool;
    return {
      quotas: hostStatusQuotas(projected),
      providers: hostStatusProviders(providers, now),
      ...(quotaPool === undefined ? {} : { quotaPool }),
      // Routed quotas carry markers here, so a reader never infers routing for this host.
      quotaRouteMarkers: true,
    };
  });

  const readLocal = Effect.fn("HostStatus.readLocal")(function* (
    includeRepositories = false,
    parityEvidence = false,
  ) {
    const snapshot = yield* resources.read;
    const platform = yield* HostProcess.Platform;
    const shells = yield* threads
      .listProjectThreads({ projectId: undefined, includeSubagents: true })
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Could not count threads on this machine."),
        ),
      );
    // Both are the last periodic reading; neither measures anything on this call.
    const storageHealth = Option.isSome(storage) ? yield* storage.value.health : null;
    const strayScan = Option.isSome(strays) ? yield* strays.value.latest : null;
    const pressure =
      pressureMonitor._tag === "Some" ? yield* pressureMonitor.value.current : undefined;
    const blockers = Option.isSome(projections)
      ? yield* projections.value.getServerActivityBlockers(5).pipe(Effect.option)
      : Option.none();
    const updateStatus =
      opencodexUpdate._tag === "Some" ? yield* opencodexUpdate.value.status : undefined;
    const raw = {
      host: null,
      reachability: "ok" as const,
      serverVersion: packageJson.version,
      ...((yield* PlacementAdmissionEnabled) ? { placementAdmission: 1 as const } : {}),
      protocol: servedRuntimeProtocolRanges(),
      ...(includeRepositories ? { repositories: yield* repositories.read } : {}),
      metrics: {
        ...snapshot,
        platform,
        // Display counts still leave subagents out; the OpenCodex idle check needs them.
        threads: {
          ...countHostThreads(shells),
          subagentsRunning: runningSubagents(shells),
          ...(Option.isSome(blockers)
            ? {
                activity: blockers.value.length > 0 ? ("busy" as const) : ("idle" as const),
                blockers: blockers.value,
              }
            : {}),
        },
        ...(yield* readQuotas()),
        ...(cua._tag === "Some" ? { computerUse: yield* cua.value.computerUse } : {}),
        ...(Option.isSome(browserReadiness) ? { browser: yield* browserReadiness.value } : {}),
        opencodex: yield* parityEvidence ? parity.readLocal : opencodex.read,
        ...(storageHealth === null ? {} : { storage: storageHealth }),
        ...(strayScan === null ? {} : { strays: strayScan }),
      },
      ...(pressure === undefined ? {} : { pressure }),
      ...(updateStatus === undefined ? {} : { opencodexUpdate: updateStatus }),
    } satisfies HostStatusEntry;
    const entry = omitUnencodableMetrics(raw);
    yield* remember(null, entry);
    return entry;
  });

  const localEntry = (includeRepositories = false, parityEvidence = false) =>
    readLocal(includeRepositories, parityEvidence).pipe(
      Effect.catch((error) =>
        Ref.get(known).pipe(
          Effect.map((current) => unreachableHostStatus(null, error.message, current.get(null))),
        ),
      ),
    );

  const readRemoteOnce = Effect.fn("HostStatus.readRemoteOnce")(function* (
    scope: McpInvocationScope,
    host: string,
    failInvalid: boolean,
    includeRepositories: boolean,
    requireReady: boolean,
  ) {
    return yield* hosts
      .readOnHost(
        scope,
        {
          host,
          tool: "goat_host_status",
          arguments: { local: true, ...(includeRepositories ? { repositories: true } : {}) },
          timeoutMs: HOST_STATUS_REMOTE_TIMEOUT_MS,
          ...(requireReady ? { requireReady: true as const } : {}),
        },
        decodeStatus,
      )
      .pipe(
        Effect.map((result) => tagRemoteHostStatus(result, host)),
        Effect.flatMap((entry) =>
          parity
            .latest(host)
            .pipe(Effect.map((result) => (result ? { ...entry, parity: result } : entry))),
        ),
        Effect.map(omitUnencodableMetrics),
        Effect.tap((entry) => (entry.reachability === "ok" ? remember(host, entry) : Effect.void)),
        Effect.catch((error) => {
          if (callerFailure(error) || (failInvalid && error.code === "invalid_request")) {
            return Effect.fail(error);
          }
          if (isUnsupportedHostStatusMessage(error.message)) {
            return Effect.succeed(unsupportedHostStatus(host));
          }
          return Ref.get(known).pipe(
            Effect.map((current) => unreachableHostStatus(host, error.message, current.get(host))),
          );
        }),
      );
  });

  /**
   * The read's own deadline covers only the tool call, not connecting first, so one host stuck
   * connecting could hold the whole fan-out past the client's timeout. The read runs on past this
   * deadline and remembers what it gets for the next poll.
   */
  const readRemote = Effect.fn("HostStatus.readRemote")(function* (
    scope: McpInvocationScope,
    host: string,
    failInvalid: boolean,
    includeRepositories: boolean,
    requireReady: boolean,
    shared: boolean,
  ) {
    const plainShared = shared && !includeRepositories && !requireReady;
    if (plainShared) {
      const now = yield* clock.currentTimeMillis;
      const answer = (yield* Ref.get(sharedAnswers)).get(host);
      if (answer !== undefined && now - answer.at < REMOTE_STATUS_FRESH_MS) return answer.entry;
    }
    const key =
      (plainShared ? "shared" : scope.requestNamespace) +
      "\u0000" +
      host +
      (failInvalid && !plainShared ? "\u0000named" : "") +
      (includeRepositories ? "\u0000repos" : "") +
      (requireReady ? "\u0000ready" : "");
    const fetch = plainShared
      ? // Shared callers turn every failure into an unreachable entry, so none needs failInvalid.
        readRemoteOnce(scope, host, false, false, false).pipe(
          Effect.tap((entry) =>
            entry.reachability === "ok"
              ? clock.currentTimeMillis.pipe(
                  Effect.flatMap((at) =>
                    Ref.update(sharedAnswers, (current) =>
                      new Map(current).set(host, { entry, at }),
                    ),
                  ),
                )
              : Effect.void,
          ),
        )
      : readRemoteOnce(scope, host, failInvalid, includeRepositories, requireReady);
    // Claimed in one atomic step, so every caller awaits the same read, even one arriving as it ends.
    const pending = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fresh = yield* Deferred.make<HostStatusEntry, OrchestratorMcpFailure>();
        const [deferred, mine] = yield* Ref.modify(
          remoteReads,
          (current): readonly [readonly [PendingRead, boolean], Map<string, PendingRead>] => {
            const existing = current.get(key);
            return existing !== undefined
              ? [[existing, false], current]
              : [[fresh, true], new Map(current).set(key, fresh)];
          },
        );
        if (mine)
          yield* fetch.pipe(
            // Leave the map before answering, so a read after this one asks the host again.
            Effect.onExit((exit) =>
              Ref.update(remoteReads, (current) => {
                if (current.get(key) !== fresh) return current;
                const next = new Map(current);
                next.delete(key);
                return next;
              }).pipe(Effect.andThen(Deferred.done(fresh, exit))),
            ),
            Effect.forkIn(layerScope),
          );
        return deferred;
      }),
    );
    const answer = yield* Deferred.await(pending).pipe(
      Effect.timeoutOption(HOST_STATUS_REMOTE_TIMEOUT_MS),
    );
    if (Option.isSome(answer)) return answer.value;
    const current = yield* Ref.get(known);
    return unreachableHostStatus(
      host,
      `${host} did not answer within ${HOST_STATUS_REMOTE_TIMEOUT_MS / 1000}s.`,
      current.get(host),
    );
  });

  const read: HostStatusMcpServiceShape["read"] = Effect.fn("HostStatus.read")(
    function* (scope, input, requested) {
      // Sharing skips the per-call authorization, so only a thread-less read-only caller holding
      // orchestration, which that authorization admits the same way, may share.
      const options =
        requested?.shared === true &&
        (scope.thread !== undefined ||
          scope.client?.access !== "read-only" ||
          !scope.capabilities.has("orchestration"))
          ? requested.requireReady === true
            ? { requireReady: true as const }
            : {}
          : requested;
      if (input.local === true && input.host !== undefined) {
        return yield* failure("invalid_request", "Pass either host or local:true, not both.");
      }
      if (input.parityEvidence && input.local !== true)
        return yield* failure("invalid_request", "Parity evidence requires local:true.");
      if (input.local === true)
        return { hosts: [yield* localEntry(input.repositories, input.parityEvidence)] };
      if (input.host !== undefined)
        return {
          hosts: [
            yield* withGoatclaw(
              markHostCompatibility(
                yield* readRemote(
                  scope,
                  input.host,
                  true,
                  input.repositories === true,
                  options?.requireReady === true,
                  options?.shared === true,
                ),
                LOCAL_HOST_COMPATIBILITY,
              ),
            ),
          ],
        };
      const aliases = [...(yield* dispatch.connectedHosts)].toSorted();
      const [local, remote] = yield* Effect.all(
        [
          localEntry(input.repositories),
          Effect.forEach(
            aliases,
            (host) =>
              readRemote(
                scope,
                host,
                false,
                input.repositories === true,
                options?.requireReady === true,
                options?.shared === true,
              ),
            { concurrency: 4 },
          ),
        ],
        { concurrency: "unbounded" },
      );
      return {
        hosts: [
          local,
          ...(yield* Effect.forEach(remote, (entry) =>
            withGoatclaw(markHostCompatibility(entry, LOCAL_HOST_COMPATIBILITY)),
          )),
        ],
      };
    },
  );

  const readForClient: HostStatusMcpServiceShape["readForClient"] = Effect.fn(
    "HostStatus.readForClient",
  )(function* (client) {
    const issuedAt = yield* clock.currentTimeMillis;
    const scope: McpInvocationScope = {
      environmentId: client.environmentId,
      capabilities: new Set(["orchestration"]),
      issuedAt,
      requestNamespace: `client-session:${client.sessionId}`,
      thread: undefined,
      // Only reads: remote hosts are asked for their own local status with writes off.
      client: { sessionId: client.sessionId, label: "GOAT client", access: "read-only" },
    };
    return yield* read(scope, client.reachHosts && client.local !== true ? {} : { local: true }, {
      shared: true,
    });
  });

  return HostStatusMcpService.of({ read, readForClient });
});

export const layer = Layer.effect(HostStatusMcpService, make);
