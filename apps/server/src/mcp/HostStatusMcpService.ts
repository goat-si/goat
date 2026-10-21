import {
  GoatHostStatusResult,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestratorMcpFailure,
  type EnvironmentId,
  type GoatHostStatusInput,
  type HostStatusEntry,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  ownRuntimeProtocolRanges,
  servedRuntimeProtocolRanges,
} from "@goat/shared/sshRuntimeProtocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OpenCodexInventory from "../opencodex/OpenCodexInventory.ts";
import * as HubParity from "../hub/HubParity.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import {
  countHostThreads,
  HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS,
  hostStatusProviders,
  hostStatusQuotas,
  isUnsupportedHostStatusMessage,
  markHostCompatibility,
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

const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);

/** This machine reads every host as a client, so it compares the protocols it speaks. */
const LOCAL_COMPATIBILITY = {
  version: packageJson.version,
  speaks: ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION),
};

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
  ) => Effect.Effect<GoatHostStatusResult, OrchestratorMcpFailure>;
  /**
   * The same read for a signed-in GOAT client, such as the web Hosts panel.
   * Connected SSH hosts are reached only with `reachHosts`, which the caller
   * grants to sessions that may operate threads: like the MCP tool's fan-out,
   * it uses this machine's SSH keys. Without it, or with `local`, only this
   * machine is read.
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
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const usageSources = yield* UsageLimitSources.UsageLimitSources;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const opencodex = yield* OpenCodexInventory.OpenCodexInventory;
  const parity = yield* HubParity.HubParity;
  const clock = yield* Clock.Clock;
  const lastRefreshAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const known = yield* Ref.make(new Map<string | null, HostStatusEntry>());
  /** Per caller and host, so a slow host's connection keeps going between polls instead of restarting. */
  const remoteReads = yield* FiberMap.make<string, HostStatusEntry, OrchestratorMcpFailure>();

  const remember = (key: string | null, entry: HostStatusEntry) =>
    Ref.update(known, (current) => {
      const next = new Map(current);
      next.set(key, entry);
      return next;
    });

  const readQuotas = Effect.fn("HostStatus.readQuotas")(function* () {
    const now = yield* clock.currentTimeMillis;
    const last = yield* Ref.get(lastRefreshAt);
    let providers = yield* registry.getProviders;
    const due = providers.filter((provider) =>
      quotaRefreshDue(provider.usageLimits, now, HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS),
    );
    const refreshed = new Set<string>();
    if (now - last >= HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS && due.length > 0) {
      yield* Ref.set(lastRefreshAt, now);
      yield* Effect.forEach(
        due,
        (provider) =>
          registry.refreshInstance(provider.instanceId).pipe(
            Effect.tap(() => Effect.sync(() => refreshed.add(provider.instanceId))),
            // A probe that fails keeps the cached windows. The rate limit still applies.
            Effect.ignore,
          ),
        { concurrency: 1, discard: true },
      );
      providers = yield* registry.getProviders;
    }
    const projected = yield* usageSources.projectProviders(providers);
    const quotaPool = yield* usageSources.quotaPool;
    return {
      quotas: hostStatusQuotas(projected, refreshed),
      providers: hostStatusProviders(providers),
      ...(quotaPool === undefined ? {} : { quotaPool }),
    };
  });

  const readLocal = Effect.fn("HostStatus.readLocal")(function* (parityEvidence = false) {
    const snapshot = yield* resources.read;
    const platform = yield* HostProcess.Platform;
    const shells = yield* threads
      .listProjectThreads({ projectId: undefined, includeSubagents: false })
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Could not count threads on this machine."),
        ),
      );
    const entry = {
      host: null,
      reachability: "ok" as const,
      serverVersion: packageJson.version,
      protocol: servedRuntimeProtocolRanges(),
      metrics: {
        ...snapshot,
        platform,
        threads: countHostThreads(shells),
        ...(yield* readQuotas()),
        opencodex: yield* parityEvidence ? parity.readLocal : opencodex.read,
      },
    } satisfies HostStatusEntry;
    yield* remember(null, entry);
    return entry;
  });

  const localEntry = (parityEvidence = false) =>
    readLocal(parityEvidence).pipe(
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
  ) {
    return yield* hosts
      .readOnHost(
        scope,
        {
          host,
          tool: "goat_host_status",
          arguments: { local: true },
          timeoutMs: HOST_STATUS_REMOTE_TIMEOUT_MS,
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
  ) {
    const key = scope.requestNamespace + "\u0000" + host + (failInvalid ? "\u0000named" : "");
    const running = yield* FiberMap.get(remoteReads, key);
    const fiber = Option.isSome(running)
      ? running.value
      : yield* FiberMap.run(remoteReads, key, readRemoteOnce(scope, host, failInvalid));
    const answer = yield* Fiber.join(fiber).pipe(
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
    function* (scope, input) {
      if (input.local === true && input.host !== undefined) {
        return yield* failure("invalid_request", "Pass either host or local:true, not both.");
      }
      if (input.parityEvidence && input.local !== true)
        return yield* failure("invalid_request", "Parity evidence requires local:true.");
      if (input.local === true) return { hosts: [yield* localEntry(input.parityEvidence)] };
      if (input.host !== undefined)
        return {
          hosts: [
            markHostCompatibility(yield* readRemote(scope, input.host, true), LOCAL_COMPATIBILITY),
          ],
        };
      const aliases = [...(yield* dispatch.connectedHosts)].toSorted();
      const [local, remote] = yield* Effect.all(
        [
          localEntry(),
          Effect.forEach(aliases, (host) => readRemote(scope, host, false), { concurrency: 4 }),
        ],
        { concurrency: "unbounded" },
      );
      return {
        hosts: [local, ...remote.map((entry) => markHostCompatibility(entry, LOCAL_COMPATIBILITY))],
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
    return yield* read(scope, client.reachHosts && client.local !== true ? {} : { local: true });
  });

  return HostStatusMcpService.of({ read, readForClient });
});

export const layer = Layer.effect(HostStatusMcpService, make);
