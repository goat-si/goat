import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@goat/contracts";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as SshAuth from "./auth.ts";
import {
  appServerSessionRequest,
  issueExistingServerCredential,
  probeExistingServer,
} from "./appServer.ts";
import { targetConnectionKey } from "./command.ts";
import { SshLaunchError, SshPairingError } from "./errors.ts";
import {
  decodeRemoteMcpSessionOutput,
  type RemoteMcpClientSession,
  type RemoteMcpClientSessionOptions,
} from "./remoteSessions.ts";
import { requestedRuntime } from "./remoteRuntime.ts";
import { sshReadinessBudget } from "./sshReadiness.ts";
import type {
  SshAuthOperationInput,
  SshEnvironmentEffectContext,
  SshEnvironmentEffectError,
  SshTunnelEntry,
  StartSshTunnelInput,
} from "./tunnel.ts";

export interface ExistingServerRouteShape {
  readonly existingEnvironment?: (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
  ) => Effect.Effect<
    { readonly httpBaseUrl: string; readonly remoteServerVersion: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly existingEnvironmentOther?: (
    target: DesktopSshEnvironmentTarget,
    currentEnvironmentId: EnvironmentId | null,
  ) => Effect.Effect<
    { readonly environmentId: EnvironmentId } | null,
    never,
    SshEnvironmentEffectContext
  >;
  readonly issueExistingMcpSession?: (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
    options: RemoteMcpClientSessionOptions,
  ) => Effect.Effect<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
}

export function makeExistingServerRoutes(input: {
  readonly managerScope: Scope.Scope;
  readonly tunnels: Map<string, SshTunnelEntry>;
  readonly resolvedTargets: Map<string, DesktopSshEnvironmentTarget>;
  readonly isClosed: () => boolean;
  readonly authFor: (key: string) => SshAuth.SshAuthOptions;
  readonly withTargetLock: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly runWithSshAuth: <T>(
    input: SshAuthOperationInput<T>,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly startTunnel: (
    input: StartSshTunnelInput,
  ) => Effect.Effect<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly shutdownTimeoutMs: number;
}) {
  const sidecars = new Map<
    string,
    { readonly kind: "app" | "managed"; readonly entry: SshTunnelEntry }
  >();
  const sidecarKey = (key: string, environmentId: string) => `${key}\u0000${environmentId}`;
  const close = (entry: SshTunnelEntry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const closeFor = Effect.fn("ssh/tunnel.closeSidecarsFor")(function* (key: string) {
    for (const [sideKey, sidecar] of sidecars) {
      if (!sideKey.startsWith(`${key}\u0000`)) continue;
      sidecars.delete(sideKey);
      yield* close(sidecar.entry);
    }
  });
  const closeAll = Effect.fn("ssh/tunnel.closeSidecars")(function* () {
    const entries = [...sidecars.values()];
    sidecars.clear();
    yield* Effect.forEach(entries, ({ entry }) => close(entry), { concurrency: "unbounded" });
  });

  const existingOwner = Effect.fn("ssh/tunnel.existingOwner")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
  ) {
    const known = input.resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const key = targetConnectionKey(known);
    const auth = input.authFor(key);
    const app = yield* probeExistingServer(known, "app", auth);
    if (app.kind === "live" && app.environmentId === environmentId)
      return { kind: "app" as const, owner: app, target: known, key };
    const managed = yield* probeExistingServer(known, "managed", auth);
    if (managed.kind === "live" && managed.environmentId === environmentId)
      return { kind: "managed" as const, owner: managed, target: known, key };
    return yield* new SshLaunchError({
      message: `GOAT environment ${environmentId} on ${target.alias} is unavailable.`,
      stdout: "",
    });
  });

  const existingEnvironmentOther = Effect.fn("ssh/tunnel.existingEnvironmentOther")(function* (
    target: DesktopSshEnvironmentTarget,
    currentEnvironmentId: EnvironmentId | null,
  ) {
    if (currentEnvironmentId === null) return null;
    const known = input.resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const auth = input.authFor(targetConnectionKey(known));
    const app = yield* probeExistingServer(known, "app", auth);
    const managed = yield* probeExistingServer(known, "managed", auth);
    const other = [app, managed].find(
      (probe) => probe.kind === "live" && probe.environmentId !== currentEnvironmentId,
    );
    return other?.kind === "live" ? { environmentId: other.environmentId } : null;
  });

  const existingEnvironment = Effect.fn("ssh/tunnel.existingEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
  ) {
    const known = input.resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const key = targetConnectionKey(known);
    return yield* input.withTargetLock(
      key,
      Effect.gen(function* () {
        if (input.isClosed())
          return yield* new SshLaunchError({ message: "SSH manager is closed.", stdout: "" });
        const selected = yield* Effect.result(existingOwner(target, environmentId));
        if (selected._tag === "Failure") {
          const staleKey = sidecarKey(key, environmentId);
          const stale = sidecars.get(staleKey);
          if (stale !== undefined) {
            sidecars.delete(staleKey);
            yield* close(stale.entry);
          }
          return yield* Effect.fail(selected.failure);
        }
        const { owner, kind } = selected.success;
        const primary = input.tunnels.get(key);
        if (
          primary !== undefined &&
          primary.remotePort === owner.port &&
          primary.remoteServerKind === kind &&
          (yield* primary.process.isRunning.pipe(Effect.orElseSucceed(() => false)))
        )
          return { httpBaseUrl: primary.httpBaseUrl, remoteServerVersion: owner.version };
        const sideKey = sidecarKey(key, environmentId);
        const previous = sidecars.get(sideKey);
        if (previous !== undefined) {
          if (
            previous.kind === kind &&
            previous.entry.remotePort === owner.port &&
            (yield* previous.entry.process.isRunning.pipe(Effect.orElseSucceed(() => false)))
          )
            return { httpBaseUrl: previous.entry.httpBaseUrl, remoteServerVersion: owner.version };
          sidecars.delete(sideKey);
          yield* close(previous.entry);
        }
        const net = yield* NetService.NetService;
        const localPort = yield* net.reserveLoopbackPort();
        const scope = yield* Scope.fork(input.managerScope, "sequential");
        const entry = yield* input
          .runWithSshAuth({
            key,
            target: selected.success.target,
            operation: (authOptions) =>
              input.startTunnel({
                key: sideKey,
                resolvedTarget: selected.success.target,
                remotePort: owner.port,
                localPort,
                httpBaseUrl: `http://127.0.0.1:${localPort}/`,
                wsBaseUrl: `ws://127.0.0.1:${localPort}/`,
                authOptions,
                remoteServerKind: kind,
                selectedRuntime: {
                  ...requestedRuntime(undefined),
                  version: owner.version,
                  source: kind === "app" ? "app" : "live",
                  mayUpgradeOwnedServer: false,
                },
                scope,
                readiness: sshReadinessBudget(0),
              }),
          })
          .pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Scope.close(scope, Exit.void).pipe(Effect.ignore),
            ),
          );
        yield* Scope.addFinalizer(
          scope,
          entry.process
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: input.shutdownTimeoutMs,
            })
            .pipe(Effect.ignore),
        );
        sidecars.set(sideKey, { kind, entry });
        return { httpBaseUrl: entry.httpBaseUrl, remoteServerVersion: owner.version };
      }),
    );
  });

  const issueExistingMcpSession = Effect.fn("ssh/tunnel.issueExistingMcpSession")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
    sessionOptions: RemoteMcpClientSessionOptions,
  ) {
    const selected = yield* existingOwner(target, environmentId);
    yield* existingEnvironment(target, environmentId);
    const request = appServerSessionRequest({
      subject: "mcp-client",
      scopes: [
        "orchestration:read",
        "orchestration:operate",
        ...(sessionOptions.approvals === true ? ["orchestration:approve"] : []),
        ...(sessionOptions.providersManage === true ? ["providers:manage"] : []),
        ...(sessionOptions.settingsWrite === true ? ["settings:write"] : []),
        ...(sessionOptions.memoryScopes ?? []),
      ],
      ttl: sessionOptions.ttl,
      label: sessionOptions.label,
      runtimeModeCeiling: sessionOptions.runtimeModeCeiling,
    });
    if (Option.isNone(request))
      return yield* new SshPairingError({
        message: `The MCP session requested for ${target.alias} has a scope or runtime mode GOAT cannot grant.`,
        stdout: "",
      });
    const body = yield* issueExistingServerCredential(
      selected.target,
      selected.kind,
      selected.owner.port,
      request.value,
      input.authFor(selected.key),
      environmentId,
    );
    const session = yield* decodeRemoteMcpSessionOutput(body).pipe(
      Effect.mapError(
        (cause) =>
          new SshPairingError({
            message: "The GOAT server did not return an MCP session.",
            stdout: body,
            cause,
          }),
      ),
    );
    if (session.token.trim().length === 0)
      return yield* new SshPairingError({
        message: "The GOAT server returned an empty MCP session token.",
        stdout: body,
      });
    return { ...session, runtimeModeCeilingApplied: sessionOptions.runtimeModeCeiling !== null };
  });

  return {
    existingEnvironment,
    existingEnvironmentOther,
    issueExistingMcpSession,
    closeFor,
    closeAll,
  };
}
