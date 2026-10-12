import {
  GoatHostStatusResult,
  OrchestratorMcpFailure,
  type EnvironmentId,
  type GoatHostStatusInput,
  type HostStatusEntry,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import {
  countHostThreads,
  HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS,
  hostStatusQuotas,
  isUnsupportedHostStatusMessage,
  quotaRefreshDue,
  tagRemoteHostStatus,
  unreachableHostStatus,
  unsupportedHostStatus,
} from "./hostStatusModel.ts";

/**
 * Shorter than the thread tools' remote deadline. A silent host is unreachable
 * and the previous sample, when there is one, stands in.
 */
export const HOST_STATUS_REMOTE_TIMEOUT_MS = 10_000;

const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);

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
   * it uses this machine's SSH keys. Without it, only this machine is read.
   */
  readonly readForClient: (client: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly reachHosts: boolean;
  }) => Effect.Effect<GoatHostStatusResult, OrchestratorMcpFailure>;
}

export class HostStatusMcpService extends Context.Service<
  HostStatusMcpService,
  HostStatusMcpServiceShape
>()("goat/mcp/HostStatusMcpService") {}

const make = Effect.gen(function* () {
  const resources = yield* HostResources.HostResources;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const clock = yield* Clock.Clock;
  const lastRefreshAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const known = yield* Ref.make(new Map<string | null, HostStatusEntry>());

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
    return hostStatusQuotas(providers, refreshed);
  });

  const readLocal = Effect.fn("HostStatus.readLocal")(function* () {
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
      metrics: {
        ...snapshot,
        platform,
        threads: countHostThreads(shells),
        quotas: yield* readQuotas(),
      },
    } satisfies HostStatusEntry;
    yield* remember(null, entry);
    return entry;
  });

  const localEntry = readLocal().pipe(
    Effect.catch((error) =>
      Ref.get(known).pipe(
        Effect.map((current) => unreachableHostStatus(null, error.message, current.get(null))),
      ),
    ),
  );

  const readRemote = Effect.fn("HostStatus.readRemote")(function* (
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

  const read: HostStatusMcpServiceShape["read"] = Effect.fn("HostStatus.read")(
    function* (scope, input) {
      if (input.local === true && input.host !== undefined) {
        return yield* failure("invalid_request", "Pass either host or local:true, not both.");
      }
      if (input.local === true) return { hosts: [yield* localEntry] };
      if (input.host !== undefined) return { hosts: [yield* readRemote(scope, input.host, true)] };
      const aliases = [...(yield* dispatch.connectedHosts)].toSorted();
      const [local, remote] = yield* Effect.all(
        [
          localEntry,
          Effect.forEach(aliases, (host) => readRemote(scope, host, false), { concurrency: 4 }),
        ],
        { concurrency: "unbounded" },
      );
      return { hosts: [local, ...remote] };
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
    return yield* read(scope, client.reachHosts ? {} : { local: true });
  });

  return HostStatusMcpService.of({ read, readForClient });
});

export const layer = Layer.effect(HostStatusMcpService, make);
