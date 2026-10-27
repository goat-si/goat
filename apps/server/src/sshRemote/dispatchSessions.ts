import {
  type AuthSessionId,
  type ChildSetupBinding,
  type ChildSetupPurpose,
  childSetupPurposeIsLive,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  type MemoryTaskGrantCeiling,
  type RuntimeMode,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import { targetConnectionKey } from "@goat/ssh/command";
import { SshPairingError } from "@goat/ssh/errors";
import type * as SshAuth from "@goat/ssh/auth";
import type * as SshTunnel from "@goat/ssh/tunnel";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import {
  describe,
  failure,
  memoryRefusal,
  type RuntimeServices,
  SshRemoteDispatchError,
} from "./dispatchFailure.ts";
import { sessionKey } from "./sshEnvironmentRoute.ts";

export const SESSION_TTL = "12h";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface DispatchSession {
  readonly token: string;
  readonly sessionId?: AuthSessionId;
  readonly expiresAt: number;
  readonly ceilingApplied: boolean;
}

/** What the dispatch service lends its session cache. */
interface SessionDeps {
  readonly manager: SshTunnel.SshEnvironmentManager["Service"];
  readonly withRuntime: <A, E>(
    effect: Effect.Effect<A, E, RuntimeServices | SshAuth.SshPasswordPrompt>,
  ) => Effect.Effect<A, E>;
  readonly sessions: Map<string, DispatchSession>;
  readonly launchArguments: Map<string, ReadonlySet<string>>;
}

const sshFailed = (alias: string) =>
  Effect.mapError((error: unknown) =>
    error instanceof SshRemoteDispatchError
      ? error
      : failure("ssh_failed", `SSH to ${alias} failed: ${describe(error)}`),
  );

const setupBindingKey = (binding: ChildSetupBinding) =>
  [
    binding.homeEnvironmentId,
    binding.destinationEnvironmentId,
    binding.operationId,
    binding.grantId,
    binding.grantRevision,
  ].join("\u0000");
/** Each phase's purpose is its own cache identity, so a later phase never reuses a bearer. */
const purposeKey = (purpose: ChildSetupPurpose) =>
  [
    setupBindingKey(purpose),
    purpose.phase,
    purpose.phaseId,
    purpose.issuedAt,
    purpose.phaseDeadline,
    purpose.expiresAt,
  ].join("\u0000");

/**
 * The remote MCP sessions SSH dispatch issues and caches. A Child setup purpose gets its own
 * read-scoped session per phase, tracked until revoked, and is never issued after its binding
 * was closed.
 */
export const makeDispatchSessions = (deps: SessionDeps) => {
  const { manager, sessions } = deps;
  const sessionLocks = new Map<string, Semaphore.Semaphore>();
  const primaryServerKinds = new Map<string, "app" | "external" | "managed">();
  // One fence orders issuance against cleanup, so a slow issue cannot register after a revoke.
  const setupSessionFence = Semaphore.makeUnsafe(1);
  const closedSetupBindings = new Set<string>();
  const purposeSessions = new Map<
    AuthSessionId,
    {
      readonly binding: ChildSetupBinding;
      readonly target: DesktopSshEnvironmentTarget;
      readonly cacheKey: string;
    }
  >();

  const sessionFor = Effect.fn("SshRemoteDispatch.sessionFor")(function* (
    target: DesktopSshEnvironmentTarget,
    ceiling: RuntimeMode,
    approvals = false,
    memoryGrantCeiling: MemoryTaskGrantCeiling = "none",
    requireReady?: true,
    providersManage = false,
    existingSessionOnly = false,
    settingsWrite = false,
    environmentId?: EnvironmentId | null,
    purpose?: ChildSetupPurpose,
  ) {
    if (
      purpose !== undefined &&
      (environmentId !== purpose.destinationEnvironmentId ||
        approvals ||
        providersManage ||
        settingsWrite ||
        memoryGrantCeiling !== "none" ||
        existingSessionOnly ||
        !childSetupPurposeIsLive(purpose, yield* Clock.currentTimeMillis))
    )
      return yield* failure("remote_refused", "Invalid bounded Child setup delegation.");
    if (environmentId === undefined || environmentId === null) {
      const kind = yield* manager.attachedServerKind?.(target) ?? Effect.succeed(null);
      const previousKind = primaryServerKinds.get(target.alias);
      if (kind !== null && previousKind !== undefined && previousKind !== kind) {
        const primaryPrefix = `${targetConnectionKey(target)}\u0000primary\u0000`;
        for (const session of sessions.keys())
          if (session.startsWith(primaryPrefix)) sessions.delete(session);
      }
      if (kind !== null) primaryServerKinds.set(target.alias, kind);
    }
    const ordinaryKey = sessionKey(
      target,
      ceiling,
      approvals,
      memoryGrantCeiling,
      providersManage,
      settingsWrite,
      environmentId,
    );
    const key = purpose === undefined ? ordinaryKey : `${ordinaryKey}\u0000${purposeKey(purpose)}`;
    if (existingSessionOnly) {
      const cached = sessions.get(key);
      const now = yield* Clock.currentTimeMillis;
      if (cached !== undefined && cached.expiresAt - SESSION_REFRESH_MARGIN_MS > now) return cached;
      return yield* failure(
        "host_unavailable",
        "No existing GOAT session permits this operation; reconnect explicitly.",
      );
    }
    const gate = sessionLocks.get(key) ?? Semaphore.makeUnsafe(1);
    sessionLocks.set(key, gate);
    const work = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = sessions.get(key);
      if (cached !== undefined && cached.expiresAt - SESSION_REFRESH_MARGIN_MS > now) return cached;
      const ttl = purpose === undefined ? SESSION_TTL : `${Math.max(1, purpose.expiresAt - now)}ms`;
      const memoryScopes: ReadonlyArray<"memory:read" | "memory:write"> =
        memoryGrantCeiling === "none"
          ? []
          : memoryGrantCeiling === "read"
            ? ["memory:read"]
            : ["memory:read", "memory:write"];
      // A session that may answer approvals is never swapped for a narrower one.
      const issueExisting = manager.issueExistingMcpSession;
      if (environmentId !== undefined && environmentId !== null && issueExisting === undefined)
        return yield* failure(
          "host_unavailable",
          "This SSH manager cannot issue a session for the requested environment.",
        );
      const issued = yield* deps
        .withRuntime(
          environmentId === undefined || environmentId === null
            ? manager.issueMcpClientSession(target, {
                ...(requireReady === undefined ? {} : { requireReady }),
                label: `GOAT SSH dispatch (${ceiling}${approvals ? ", approvals" : ""}${providersManage ? ", providers" : ""}${settingsWrite ? ", settings" : ""})`,
                ttl,
                runtimeModeCeiling: ceiling,
                ...(approvals ? { approvals: true } : {}),
                ...(providersManage ? { providersManage: true } : {}),
                ...(settingsWrite ? { settingsWrite: true } : {}),
                memoryScopes,
              })
            : issueExisting === undefined
              ? Effect.die("Existing session issuer disappeared")
              : issueExisting(target, environmentId, {
                  label: `GOAT SSH dispatch (${purpose === undefined ? ceiling : "Child setup"})`,
                  ttl,
                  runtimeModeCeiling: ceiling,
                  ...(purpose === undefined ? {} : { childSetupPurpose: purpose }),
                  ...(approvals ? { approvals: true } : {}),
                  ...(providersManage ? { providersManage: true } : {}),
                  ...(settingsWrite ? { settingsWrite: true } : {}),
                  memoryScopes,
                }),
        )
        .pipe(
          // The remote answered and refused; its message names the runtime and what happens next.
          Effect.mapError((error) =>
            error instanceof SshPairingError && error.reason === "memory-scopes-unsupported"
              ? memoryRefusal(error.message)
              : error,
          ),
          approvals
            ? Effect.mapError((error) =>
                error instanceof SshRemoteDispatchError
                  ? error
                  : failure(
                      "remote_refused",
                      `${target.alias} could not issue a GOAT session that may answer approvals: ${describe(error)}. Update GOAT there, or let the user answer in that thread.`,
                    ),
              )
            : providersManage
              ? Effect.mapError((error) =>
                  error instanceof SshRemoteDispatchError
                    ? error
                    : failure(
                        "remote_refused",
                        `${target.alias} could not issue a GOAT session that may manage providers: ${describe(error)}. Update GOAT there, or manage providers in Settings on ${target.alias}.`,
                      ),
                )
              : sshFailed(target.alias),
        );
      if (purpose !== undefined && issued.sessionId === undefined)
        return yield* failure(
          "remote_refused",
          "This GOAT issuer did not identify the Child setup session. Update GOAT there.",
        );
      const parsedExpiry = issued.expiresAt === null ? Number.NaN : Date.parse(issued.expiresAt);
      const session: DispatchSession = {
        ...(issued.sessionId === undefined ? {} : { sessionId: issued.sessionId }),
        token: issued.token,
        expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + SESSION_TTL_MS,
        ceilingApplied: issued.runtimeModeCeilingApplied,
      };
      sessions.set(key, session);
      deps.launchArguments.delete(key);
      if (purpose !== undefined && issued.sessionId !== undefined)
        purposeSessions.set(issued.sessionId, { binding: purpose, target, cacheKey: key });
      return session;
    });
    const guardedWork =
      purpose === undefined
        ? work
        : setupSessionFence.withPermit(
            Effect.gen(function* () {
              if (closedSetupBindings.has(setupBindingKey(purpose)))
                return yield* failure(
                  "remote_refused",
                  "This setup operation was revoked before session issuance.",
                );
              return yield* work;
            }),
          );
    if (requireReady === true) {
      const result = yield* guardedWork.pipe(gate.withPermitsIfAvailable(1));
      if (Option.isNone(result))
        return yield* failure(
          "host_unavailable",
          purpose === undefined
            ? `Call ${goatCallText("ssh.host_prepare")} for ${target.alias}, then call ${goatCallText("ssh.host_status")} until setup completes; retry ${goatCallText("provider.diagnose")}.`
            : "The Child session issuer is busy. Retry setup.",
        );
      return result.value;
    }
    return yield* guardedWork.pipe(gate.withPermit);
  });

  /**
   * Closes a setup binding and revokes every phase session issued under it on the Child, over
   * the original pinned owner. A failed revoke keeps the binding closed; the bearer still
   * expires five minutes after its phase deadline, and the Home refuses its replies.
   */
  const revokeChildSetupSessions = Effect.fn("SshRemoteDispatch.revokeChildSetupSessions")(
    function* (binding: ChildSetupBinding) {
      const key = setupBindingKey(binding);
      return yield* setupSessionFence.withPermit(
        Effect.gen(function* () {
          closedSetupBindings.add(key);
          const owned = [...purposeSessions.entries()].filter(
            ([, session]) => setupBindingKey(session.binding) === key,
          );
          for (const [, session] of owned) sessions.delete(session.cacheKey);
          const revoke = manager.revokeExistingMcpSession;
          if (owned.length > 0 && revoke === undefined)
            return yield* failure(
              "remote_refused",
              "The Child runtime cannot revoke setup sessions. Pending credentials will expire.",
            );
          for (const [sessionId, session] of owned) {
            if (revoke === undefined) break;
            yield* deps
              .withRuntime(revoke(session.target, binding.destinationEnvironmentId, sessionId))
              .pipe(sshFailed(session.target.alias));
            purposeSessions.delete(sessionId);
          }
        }),
      );
    },
  );

  /** Forgets cached primary-server kinds for an alias whose address or host key changed. */
  const forgetAlias = (alias: string) => primaryServerKinds.delete(alias);

  return { sessionFor, revokeChildSetupSessions, forgetAlias };
};
