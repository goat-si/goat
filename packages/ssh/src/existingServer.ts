import {
  type AuthSessionId,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  RuntimeSessionRevokeResult,
} from "@goat/contracts";
import * as NetService from "@goat/shared/Net";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as SshAuth from "./auth.ts";
import {
  appServerSessionRequest,
  issueExistingServerCredential,
  probeExistingServer,
  readForwardEnvironment,
} from "./appServer.ts";
import { targetConnectionKey } from "./command.ts";
import { SshLaunchError, SshPairingError } from "./errors.ts";
import {
  decodeRemoteMcpSessionOutput,
  mcpSessionRequestInput,
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
    | { readonly kind: "live"; readonly environmentId: EnvironmentId }
    | { readonly kind: "absent" }
    | { readonly kind: "unavailable" },
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
  /** Ends one session on that server, through the same pinned owner that issued it. */
  readonly revokeExistingMcpSession?: (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
    sessionId: AuthSessionId,
  ) => Effect.Effect<boolean, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

const decodeRevokeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeSessionRevokeResult),
);

/** How long a route verified over SSH is reused before ownership on disk is probed again. */
const OWNER_RECHECK_MS = 5 * 60_000;

interface VerifiedRoute {
  readonly kind: "app" | "managed";
  readonly port: number;
  readonly target: DesktopSshEnvironmentTarget;
  readonly key: string;
  readonly httpBaseUrl: string;
  readonly verifiedAt: number;
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
  // Routes verified over SSH, by sidecar key; a reuse still needs its forward to answer.
  const routes = new Map<string, VerifiedRoute>();
  const sidecarKey = (key: string, environmentId: string) => `${key}\u0000${environmentId}`;
  const close = (entry: SshTunnelEntry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const closeFor = Effect.fn("ssh/tunnel.closeSidecarsFor")(function* (key: string) {
    for (const sideKey of routes.keys())
      if (sideKey.startsWith(`${key}\u0000`)) routes.delete(sideKey);
    for (const [sideKey, sidecar] of sidecars) {
      if (!sideKey.startsWith(`${key}\u0000`)) continue;
      sidecars.delete(sideKey);
      yield* close(sidecar.entry);
    }
  });
  const closeAll = Effect.fn("ssh/tunnel.closeSidecars")(function* () {
    const entries = [...sidecars.values()];
    sidecars.clear();
    routes.clear();
    yield* Effect.forEach(entries, ({ entry }) => close(entry), { concurrency: "unbounded" });
  });

  /**
   * Probes the host's GOAT servers over SSH for the one that owns `environmentId` on disk,
   * starting with the kind that owned it last time; each probe is a new SSH connection.
   */
  const existingOwner = Effect.fn("ssh/tunnel.existingOwner")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
    first: "app" | "managed" = "app",
  ) {
    const known = input.resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const key = targetConnectionKey(known);
    const auth = input.authFor(key);
    for (const kind of first === "app"
      ? (["app", "managed"] as const)
      : (["managed", "app"] as const)) {
      const owner = yield* probeExistingServer(known, kind, auth);
      if (owner.kind === "live" && owner.environmentId === environmentId)
        return { kind, owner, target: known, key };
    }
    return yield* new SshLaunchError({
      message: `GOAT environment ${environmentId} on ${target.alias} is unavailable (app: ${app.kind}${app.kind !== "live" && app.reason ? ` ${app.reason}` : ""}; managed: ${managed.kind}${managed.kind !== "live" && managed.reason ? ` ${managed.reason}` : ""}).`,
      stdout: "",
    });
  });

  const existingEnvironmentOther = Effect.fn("ssh/tunnel.existingEnvironmentOther")(function* (
    target: DesktopSshEnvironmentTarget,
    currentEnvironmentId: EnvironmentId | null,
  ) {
    if (currentEnvironmentId === null) return { kind: "unavailable" as const };
    const known = input.resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const auth = input.authFor(targetConnectionKey(known));
    const app = yield* probeExistingServer(known, "app", auth);
    const managed = yield* probeExistingServer(known, "managed", auth);
    const other = [app, managed].find(
      (probe) => probe.kind === "live" && probe.environmentId !== currentEnvironmentId,
    );
    if (other?.kind === "live")
      return { kind: "live" as const, environmentId: other.environmentId };
    return app.kind === "absent" && managed.kind === "absent"
      ? { kind: "absent" as const }
      : app.kind === "unusable" || managed.kind === "unusable"
        ? { kind: "unavailable" as const }
        : { kind: "absent" as const };
  });

  /** The open forward a verified route still uses, if it is the same one. */
  const forwardFor = (route: VerifiedRoute, sideKey: string) => {
    const primary = input.tunnels.get(route.key);
    if (
      primary?.httpBaseUrl === route.httpBaseUrl &&
      primary.remotePort === route.port &&
      primary.remoteServerKind === route.kind
    )
      return primary;
    const sidecar = sidecars.get(sideKey);
    return sidecar?.kind === route.kind &&
      sidecar.entry.httpBaseUrl === route.httpBaseUrl &&
      sidecar.entry.remotePort === route.port
      ? sidecar.entry
      : undefined;
  };

  /** What the forward's own server reports, when it still serves `environmentId`. */
  const answersFor = Effect.fn("ssh/tunnel.existingEnvironment.answersFor")(function* (
    forward: SshTunnelEntry,
    environmentId: EnvironmentId,
  ) {
    if (!(yield* forward.process.isRunning.pipe(Effect.orElseSucceed(() => false))))
      return undefined;
    const live = yield* readForwardEnvironment(
      forward.httpBaseUrl,
      forward.readiness.probeTimeoutMs,
    );
    return live?.environmentId === environmentId ? live : undefined;
  });

  /**
   * A route verified over SSH within OWNER_RECHECK_MS whose forward still answers for the same
   * environment. It costs one HTTP request through that forward, never a new SSH connection.
   */
  const reuseRoute = Effect.fn("ssh/tunnel.existingEnvironment.reuse")(function* (
    sideKey: string,
    environmentId: EnvironmentId,
  ) {
    const route = routes.get(sideKey);
    if (route === undefined) return undefined;
    if ((yield* Clock.currentTimeMillis) - route.verifiedAt >= OWNER_RECHECK_MS) return undefined;
    const forward = forwardFor(route, sideKey);
    if (forward === undefined) return undefined;
    const live = yield* answersFor(forward, environmentId);
    // Teardown, replacement, or a strict recheck may have run while the forward answered.
    if (
      live === undefined ||
      input.isClosed() ||
      routes.get(sideKey) !== route ||
      forwardFor(route, sideKey) !== forward
    )
      return undefined;
    return { ...route, version: live.version };
  });

  const resolveRoute = Effect.fn("ssh/tunnel.existingEnvironment.route")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
  ) {
    const known = input.resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const key = targetConnectionKey(known);
    const sideKey = sidecarKey(key, environmentId);
    if (input.isClosed())
      return yield* new SshLaunchError({ message: "SSH manager is closed.", stdout: "" });
    const reused = yield* reuseRoute(sideKey, environmentId);
    if (reused !== undefined) return reused;
    return yield* input.withTargetLock(
      key,
      Effect.gen(function* () {
        if (input.isClosed())
          return yield* new SshLaunchError({ message: "SSH manager is closed.", stdout: "" });
        // A call that held the lock before this one may have just verified the route.
        const verifiedMeanwhile = yield* reuseRoute(sideKey, environmentId);
        if (verifiedMeanwhile !== undefined) return verifiedMeanwhile;
        const selected = yield* Effect.result(
          existingOwner(target, environmentId, routes.get(sideKey)?.kind),
        );
        if (selected._tag === "Failure") {
          routes.delete(sideKey);
          const stale = sidecars.get(sideKey);
          if (stale !== undefined) {
            sidecars.delete(sideKey);
            yield* close(stale.entry);
          }
          return yield* Effect.fail(selected.failure);
        }
        const { owner, kind } = selected.success;
        const verified = (httpBaseUrl: string) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((verifiedAt) => {
              const route = {
                kind,
                port: owner.port,
                target: selected.success.target,
                key,
                httpBaseUrl,
                verifiedAt,
              };
              routes.set(sideKey, route);
              return { ...route, version: owner.version };
            }),
          );
        const primary = input.tunnels.get(key);
        if (
          primary !== undefined &&
          primary.remotePort === owner.port &&
          primary.remoteServerKind === kind &&
          (yield* answersFor(primary, environmentId)) !== undefined
        )
          return yield* verified(primary.httpBaseUrl);
        const previous = sidecars.get(sideKey);
        if (previous !== undefined) {
          if (
            previous.kind === kind &&
            previous.entry.remotePort === owner.port &&
            (yield* answersFor(previous.entry, environmentId)) !== undefined
          )
            return yield* verified(previous.entry.httpBaseUrl);
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
        // A new SSH session can land on another backend than the probe's; never route through it.
        if ((yield* answersFor(entry, environmentId)) === undefined) {
          routes.delete(sideKey);
          yield* Scope.close(scope, Exit.void);
          return yield* new SshLaunchError({
            message: `The forward to ${target.alias} does not reach GOAT environment ${environmentId}.`,
            stdout: "",
          });
        }
        sidecars.set(sideKey, { kind, entry });
        return yield* verified(entry.httpBaseUrl);
      }),
    );
  });

  const existingEnvironment = Effect.fn("ssh/tunnel.existingEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
  ) {
    const route = yield* resolveRoute(target, environmentId);
    return { httpBaseUrl: route.httpBaseUrl, remoteServerVersion: route.version };
  });

  const issueExistingMcpSession = Effect.fn("ssh/tunnel.issueExistingMcpSession")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
    sessionOptions: RemoteMcpClientSessionOptions,
  ) {
    // The host's credential script checks the owner's port and environment again.
    const selected = yield* resolveRoute(target, environmentId);
    const request = appServerSessionRequest(mcpSessionRequestInput(sessionOptions));
    if (Option.isNone(request))
      return yield* new SshPairingError({
        message: `The MCP session requested for ${target.alias} has a scope or runtime mode GOAT cannot grant.`,
        stdout: "",
      });
    const body = yield* issueExistingServerCredential(
      selected.target,
      selected.kind,
      selected.port,
      request.value,
      input.authFor(selected.key),
      environmentId,
    );
    const session = yield* decodeRemoteMcpSessionOutput(
      body,
      sessionOptions.childSetupPurpose,
    ).pipe(
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

  const revokeExistingMcpSession = Effect.fn("ssh/tunnel.revokeExistingMcpSession")(function* (
    target: DesktopSshEnvironmentTarget,
    environmentId: EnvironmentId,
    sessionId: AuthSessionId,
  ) {
    const selected = yield* resolveRoute(target, environmentId);
    const body = yield* issueExistingServerCredential(
      selected.target,
      selected.kind,
      selected.port,
      { kind: "revoke", sessionId },
      input.authFor(selected.key),
      environmentId,
    );
    const result = yield* decodeRevokeResult(body).pipe(
      Effect.mapError(
        (cause) =>
          new SshPairingError({
            message: "The Child did not acknowledge session revocation.",
            stdout: "",
            cause,
          }),
      ),
    );
    if (result.sessionId !== sessionId)
      return yield* new SshPairingError({
        message: "The Child acknowledged a different session.",
        stdout: "",
      });
    return result.revoked;
  });

  return {
    revokeExistingMcpSession,
    existingEnvironment,
    existingEnvironmentOther,
    issueExistingMcpSession,
    closeFor,
    closeAll,
  };
}
