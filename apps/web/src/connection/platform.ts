import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@goat/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  sshPreparationFailure,
  withSshConnectionTiming,
  sshTargetKey,
  Wakeups,
} from "@goat/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@goat/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@goat/client-runtime/environment";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@goat/client-runtime/relay";
import { EnvironmentRpcRequestObserver } from "@goat/client-runtime/rpc";
import type { SshRuntimeOwnerGateway } from "@goat/client-runtime/state/sshRuntime";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  AuthStandardClientScopes,
  SshHostResult,
  type SshRuntimeUpdateMode,
  type CloudMachineAlias,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type DesktopSshPreparationProgress,
  type DesktopSshAttemptContext,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  isCloudMachineAlias,
  isCloudMachineError,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import { APP_VERSION } from "../branding";
import { parseOAuthScope } from "@goat/shared/oauthScope";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { desktopWakeups } from "./desktopWakeups";
import {
  desktopLocalConnectionId,
  readDesktopSecondaryBootstrapsResult,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import * as ConnectionStorage from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";
import { desktopSshPairingGrantStore } from "./sshPairingGrantStore";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

export interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

function activeNetworkPathType(type: string | undefined): string | undefined {
  return type === undefined || type === "none" || type === "unknown" ? undefined : type;
}

/**
 * `change` also fires for bandwidth and latency estimates on the same network,
 * so only a path change or a drop-and-reconnect counts.
 */
export function networkPathChangesFrom(
  readConnection: () => NetworkInformationLike | undefined,
): Stream.Stream<"network-changed"> {
  return Stream.callback<"network-changed">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const connection = readConnection();
        if (connection === undefined) return undefined;
        let previous = activeNetworkPathType(connection.type);
        let disconnected = false;
        const listener = () => {
          const type = activeNetworkPathType(connection.type);
          if (type === undefined) {
            if (previous !== undefined) {
              disconnected = true;
            }
            return;
          }
          const changed = previous !== undefined && (type !== previous || disconnected);
          previous = type;
          disconnected = false;
          if (changed) {
            Queue.offerUnsafe(queue, "network-changed");
          }
        };
        connection.addEventListener("change", listener);
        return { connection, listener };
      }),
      (subscription) =>
        Effect.sync(() =>
          subscription?.connection.removeEventListener("change", subscription.listener),
        ),
    ).pipe(Effect.asVoid),
  );
}

const networkPathChanges = networkPathChangesFrom(() =>
  typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection,
);

// Without a desktop bridge that reports sleep (a browser tab, an older
// desktop build), visibility, network type, and credentials are the only wakeups.
const desktopShellWakeups = Stream.suspend(() => {
  const onSystemWake =
    typeof window === "undefined" ? undefined : window.desktopBridge?.onSystemWake;
  return onSystemWake === undefined
    ? Stream.empty
    : desktopWakeups({ onSystemWake, window, nowMs: () => Date.now() });
});

const layerWakeups = Wakeups.layer({
  changes: Stream.mergeAll(
    [
      Stream.callback<"application-active">((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => {
              if (document.visibilityState === "visible") {
                Queue.offerUnsafe(queue, "application-active");
              }
            };
            document.addEventListener("visibilitychange", listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              document.removeEventListener("visibilitychange", listener);
            }),
        ).pipe(Effect.asVoid),
      ),
      managedRelayAccountChanges(appAtomRegistry).pipe(
        Stream.map(() => "credentials-changed" as const),
      ),
      networkPathChanges,
      desktopShellWakeups,
    ],
    { concurrency: "unbounded" },
  ),
});

function clientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: isHostedStaticApp(),
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
}

function sshRuntimePendingError(pending: {
  readonly reason: "busy" | "unknown" | "contended";
  readonly detail?: "recovery-stale";
  readonly refreshCause?: "drain_unavailable";
  readonly replacement: "older" | "legacy" | "incompatible" | "capability";
  readonly liveVersion: string;
  readonly requestedVersion: string;
}) {
  const waiting =
    pending.replacement === "capability"
      ? `Remote runtime GOAT ${pending.liveVersion} cannot grant memory access to tasks, so it will be replaced with GOAT ${pending.requestedVersion} when its work finishes.`
      : "Remote runtime will be replaced when its work finishes.";
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail:
      pending.detail === "recovery-stale"
        ? "Remote recovery is locked. Remove ~/.goat/ssh-launch/replacement.recovery on the remote host after checking that no GOAT client is replacing this runtime."
        : pending.refreshCause === "drain_unavailable"
          ? `Remote runtime GOAT ${pending.liveVersion} can't hand over to GOAT ${pending.requestedVersion} right now. GOAT retries every 10 minutes.`
          : pending.reason === "contended"
            ? "Another client is replacing the remote runtime."
            : pending.reason === "unknown"
              ? `${waiting} Waiting for a verified idle response.`
              : waiting,
  });
}

/** Readies a cloud machine through the GOAT server that owns it, before the desktop dials it. */
export type CloudMachinePreflight = (alias: string) => Effect.Effect<void, ConnectionBlockedError>;

/**
 * Asks this desktop's own server to refresh the machine's address and pinned host key. It never
 * wakes a stopped machine, because reconnects and route checks run this too; Resume in Settings
 * does. Loaded lazily: the server state module depends on this connection layer.
 */
const readyCloudMachineThroughPrimary: CloudMachinePreflight = Effect.fn(
  "web.connectionPlatform.ssh.readyCloudMachine",
)(function* (alias) {
  const [{ serverEnvironment }, { primaryEnvironmentIdAtom }] = yield* Effect.promise(() =>
    Promise.all([import("../state/server"), import("../state/primaryEnvironment")]),
  );
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null)
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Connect to this computer's GOAT server before opening a cloud machine.",
    });
  const result = yield* Effect.promise(() =>
    serverEnvironment.ensureCloudMachineReady.run(appAtomRegistry, {
      environmentId,
      input: { alias: alias as CloudMachineAlias },
    }),
  );
  if (result._tag === "Success") return;
  const error = squashAtomCommandFailure(result);
  return yield* new ConnectionBlockedError({
    reason: "configuration",
    detail: !isCloudMachineError(error)
      ? "Could not prepare this cloud machine."
      : error.reason === "not_found"
        ? "This cloud machine belongs to another GOAT server. Open it from that server."
        : error.message,
  });
});

const preflightCloudMachine = (alias: string, ready: CloudMachinePreflight) =>
  isCloudMachineAlias(alias) ? ready(alias) : Effect.void;

/**
 * Scopes a fresh pairing was granted by one server instance reached through one SSH target. A
 * runtime older than this app's standard scopes grants the same narrower set to every pairing,
 * so requiring the full standard set there would mint a token, and add a session on the host,
 * on every reconnect without ever gaining a scope. The key names the live server's instance
 * (new on every start, so an upgrade or restart misses) and the SSH target, so another host
 * claiming the same environment cannot lower what this one is asked for.
 */
export type SshPairingGrants = Map<string, ReadonlyArray<string>>;
const sshPairingGrants: SshPairingGrants = new Map();

type PairingGrantServer = Pick<
  ExecutionEnvironmentDescriptor,
  "environmentId" | "serverVersion" | "instanceId"
>;

const pairingGrantKey = (server: PairingGrantServer, target: DesktopSshEnvironmentTarget) =>
  server.instanceId === undefined
    ? undefined
    : JSON.stringify([
        server.environmentId,
        server.instanceId,
        server.serverVersion,
        target.alias,
        target.hostname,
        target.username,
        target.port,
        // A newer client must probe again if its standard scope requirements grew.
        AuthStandardClientScopes,
      ]);

/** The standard scopes a saved SSH token must still hold to be reused instead of re-paired. */
function requiredSshTokenScopes(
  grants: SshPairingGrants,
  server: PairingGrantServer,
  target: DesktopSshEnvironmentTarget,
) {
  const key = pairingGrantKey(server, target);
  const granted = key === undefined ? undefined : grants.get(key);
  const required =
    granted === undefined
      ? []
      : AuthStandardClientScopes.filter((scope) => granted.includes(scope));
  // A grant with no standard scope at all says nothing about this server; never accept any token.
  return required.length === 0 ? AuthStandardClientScopes : required;
}

function isExplicitSshCredentialRejection(error: ConnectionAttemptError): boolean {
  return (
    error._tag === "ConnectionBlockedError" &&
    (/\[ssh_http:(?:401|403)\]/u.test(error.detail) ||
      error.detail === "The environment credential is invalid." ||
      error.detail === "The environment credential does not grant the required access.")
  );
}

interface DesktopSshPreparationOptions {
  readonly keyOnly?: boolean;
  readonly onHostAnswered?: Effect.Effect<void>;
  readonly onPreparationProgress?: (progress: DesktopSshPreparationProgress) => Effect.Effect<void>;
  readonly attemptContext?: DesktopSshAttemptContext;
  readonly preparedAttachmentId?: string;
}

// One consumer preserves terminal ordering without detached callback effects. Old preloads
// receive only serializable options; their IPC dispatcher does not strip functions.
const ensureDesktopSshRuntime = Effect.fn("web.connectionPlatform.ssh.ensure")(function* (
  bridge: DesktopBridge,
  target: DesktopSshEnvironmentTarget,
  issuePairingToken: boolean,
  options?: DesktopSshPreparationOptions,
) {
  type Report =
    | { readonly type: "answered" }
    | { readonly type: "phase"; readonly progress: DesktopSshPreparationProgress }
    | { readonly type: "done" };
  const reports = yield* Queue.bounded<Report>(64);
  let active = true;
  let answered = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active = false;
    }),
  );
  const consumer = yield* Effect.gen(function* () {
    while (true) {
      const report = yield* Queue.take(reports);
      if (report.type === "done") return;
      yield* Effect.suspend(() =>
        report.type === "answered"
          ? (options?.onHostAnswered ?? Effect.void)
          : (options?.onPreparationProgress?.(report.progress) ?? Effect.void),
      ).pipe(Effect.ignoreCause);
    }
  }).pipe(Effect.forkScoped);
  const result = yield* Effect.tryPromise({
    try: () =>
      bridge.ensureSshEnvironment(target, {
        issuePairingToken,
        ...(options?.keyOnly === undefined ? {} : { keyOnly: options.keyOnly }),
        ...(target.alias.startsWith("goat-") ? { keyOnly: true } : {}),
        ...(bridge.supportsSshEnvironmentProgress === true
          ? {
              onHostAnswered: () => {
                if (!active || answered) return;
                answered = true;
                Queue.offerUnsafe(reports, { type: "answered" });
              },
            }
          : {}),
        ...(bridge.supportsSshPreparationPhases === true
          ? {
              caller: issuePairingToken ? ("provision" as const) : ("saved-connection" as const),
              ...(options?.attemptContext === undefined
                ? {}
                : { attemptContext: options.attemptContext }),
              ...(options?.preparedAttachmentId === undefined
                ? {}
                : { preparedAttachmentId: options.preparedAttachmentId }),
              onPreparationProgress: (progress: DesktopSshPreparationProgress) => {
                if (active) Queue.offerUnsafe(reports, { type: "phase", progress });
              },
            }
          : {}),
      }),
    catch: sshPreparationFailure,
  }).pipe(withSshConnectionTiming("ensure"), Effect.exit);
  active = false;
  yield* Queue.offer(reports, { type: "done" });
  yield* Fiber.join(consumer);
  return yield* result;
}, Effect.scoped);

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (
  bridge: DesktopBridge,
  target: DesktopSshEnvironmentTarget,
  expectedEnvironmentId?: EnvironmentId,
  options?: DesktopSshPreparationOptions,
  readyCloudMachine: CloudMachinePreflight = readyCloudMachineThroughPrimary,
  grants: SshPairingGrants = sshPairingGrants,
) {
  yield* preflightCloudMachine(target.alias, readyCloudMachine);
  const bootstrap = yield* ensureDesktopSshRuntime(bridge, target, true, options);
  if ("type" in bootstrap) return yield* sshRuntimePendingError(bootstrap.pending);
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationFailure,
  }).pipe(withSshConnectionTiming("descriptor"));
  if (expectedEnvironmentId !== undefined && descriptor.environmentId !== expectedEnvironmentId) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `That host reaches ${descriptor.label}, a different machine. Add it as its own environment instead.`,
    });
  }
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: sshPreparationFailure,
  }).pipe(withSshConnectionTiming("pairing"));
  // Reconnects look the record up by the resolved target the bridge returns, which is also
  // what the saved profile keeps.
  const grantKey = pairingGrantKey(descriptor, bootstrap.target);
  const granted = grantKey === undefined ? null : parseOAuthScope(access.scope);
  if (grantKey !== undefined && granted !== null) grants.set(grantKey, granted);
  const sshPairingGrant =
    grantKey !== undefined && granted !== null && desktopSshPairingGrantStore(bridge) !== undefined
      ? {
          key: grantKey,
          scopes: AuthStandardClientScopes.filter((scope) => granted.includes(scope)),
        }
      : undefined;
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
    verifiedEndpoint: { httpBaseUrl: bootstrap.httpBaseUrl, descriptor },
    ...(sshPairingGrant === undefined ? {} : { sshPairingGrant }),
  };
});

/**
 * Connects a saved SSH environment. A token from an earlier pairing is kept
 * while the host still accepts it with every standard scope, because every
 * pairing adds a session there.
 */
export const prepareDesktopSshEnvironment = Effect.fn("web.connectionPlatform.ssh.prepareDesktop")(
  function* (
    bridge: DesktopBridge,
    input: Omit<
      Parameters<ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"]>[0],
      "connectionId"
    > & { readonly connectionId?: string },
    readyCloudMachine: CloudMachinePreflight = readyCloudMachineThroughPrimary,
    grants: SshPairingGrants = sshPairingGrants,
  ) {
    yield* preflightCloudMachine(input.target.alias, readyCloudMachine);
    const progressOptions: DesktopSshPreparationOptions = {
      ...(input.onHostAnswered === undefined ? {} : { onHostAnswered: input.onHostAnswered }),
      ...(input.onPreparationProgress === undefined
        ? {}
        : { onPreparationProgress: input.onPreparationProgress }),
      ...(input.attemptContext === undefined ? {} : { attemptContext: input.attemptContext }),
    };
    let preparedAttachmentId: string | undefined;
    const bearerToken = input.bearerToken;
    if (bearerToken !== undefined) {
      const bootstrap = yield* ensureDesktopSshRuntime(
        bridge,
        input.target,
        false,
        progressOptions,
      );
      if ("type" in bootstrap) return yield* sshRuntimePendingError(bootstrap.pending);
      if (bridge.supportsSshPreparationPhases === true)
        preparedAttachmentId = bootstrap.attachmentId;
      // Stop without sending the saved token, or pairing, when the forward
      // reaches a different environment.
      const descriptor = yield* Effect.tryPromise({
        try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
        catch: sshPreparationFailure,
      }).pipe(withSshConnectionTiming("descriptor"));
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: `That host reaches ${descriptor.label}, a different machine. Add it as its own environment instead.`,
        });
      }
      const prepared = {
        bootstrap,
        bearerToken,
        verifiedEndpoint: { httpBaseUrl: bootstrap.httpBaseUrl, descriptor },
      };
      // Keep ticket errors as values until the session check decides whether to
      // pair. This scope discards speculative work on cancellation or re-pairing.
      const endpointVerified = yield* Deferred.make<
        ExecutionEnvironmentDescriptor,
        ConnectionAttemptError
      >();
      const authorization =
        input.authorize === undefined
          ? undefined
          : yield* input
              .authorize(prepared, (descriptor) => Deferred.succeed(endpointVerified, descriptor))
              .pipe(
                Effect.tapCause((cause) => Deferred.failCause(endpointVerified, cause)),
                Effect.result,
                Effect.forkScoped,
              );
      const verified =
        authorization === undefined
          ? undefined
          : yield* Deferred.await(endpointVerified).pipe(Effect.result);
      const savedCredentialRejected =
        verified?._tag === "Failure" && isExplicitSshCredentialRejection(verified.failure);
      if (verified?._tag === "Failure" && !savedCredentialRejected) return yield* verified.failure;
      const verifiedDescriptor = verified?._tag === "Success" ? verified.success : descriptor;
      const grantKey = pairingGrantKey(verifiedDescriptor, bootstrap.target);
      const secureStore = desktopSshPairingGrantStore(bridge);
      const persisted =
        secureStore === undefined
          ? undefined
          : yield* secureStore
              .load(
                input.connectionId ??
                  `ssh:${descriptor.environmentId}:${sshTargetKey(bootstrap.target)}`,
                bearerToken,
                grantKey,
              )
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning(
                    "Could not load the secure SSH pairing grant; requiring all standard scopes.",
                  ).pipe(Effect.as(undefined)),
                ),
              );
      // Secure storage is authoritative across windows and launches, including deletions.
      const effectiveGrants =
        secureStore === undefined
          ? grants
          : new Map(
              persisted?.grant === undefined ? [] : [[persisted.grant.key, persisted.grant.scopes]],
            );
      const invalidate = Effect.gen(function* () {
        if (grantKey !== undefined) grants.delete(grantKey);
        if (persisted !== undefined) yield* persisted.invalidate;
      });
      const session = savedCredentialRejected
        ? { authenticated: false, permissions: [] as readonly string[] }
        : yield* Effect.tryPromise({
            try: () => bridge.fetchSshSessionState(bootstrap.httpBaseUrl, bearerToken),
            catch: (cause) => ({
              cause,
              revoked: /\[ssh_http:(?:401|403)\]/u.test(
                cause instanceof Error ? cause.message : String(cause),
              ),
            }),
          }).pipe(
            Effect.catch((error) =>
              error.revoked
                ? invalidate.pipe(
                    Effect.as({
                      authenticated: false as const,
                      permissions: [] as readonly string[],
                    }),
                  )
                : Effect.fail(sshPreparationFailure(error.cause)),
            ),
            withSshConnectionTiming("session"),
          );
      if (!session.authenticated) yield* invalidate;
      // Servers never widen a stored grant, so a token from before the standard
      // scopes grew is replaced by pairing again, unless this runtime grants no more.
      const granted = session.permissions ?? ("scopes" in session ? session.scopes : []) ?? [];
      if (
        session.authenticated &&
        requiredSshTokenScopes(effectiveGrants, verifiedDescriptor, bootstrap.target).every(
          (scope) => granted.includes(scope),
        )
      ) {
        const authorizationResult =
          authorization === undefined ? undefined : yield* Fiber.join(authorization);
        if (
          authorizationResult?._tag === "Failure" &&
          !isExplicitSshCredentialRejection(authorizationResult.failure)
        ) {
          return yield* authorizationResult.failure;
        }
        if (authorizationResult?._tag !== "Failure") {
          const authorized: ClientCapabilities.PreparedSshEnvironment = {
            ...prepared,
            ...(persisted?.grant === undefined ? {} : { sshPairingGrant: persisted.grant }),
            verifiedEndpoint: {
              httpBaseUrl: bootstrap.httpBaseUrl,
              descriptor: verifiedDescriptor,
            },
            ...(authorizationResult?._tag === "Success"
              ? { authorization: authorizationResult.success }
              : {}),
          };
          return authorized;
        }
      }
      yield* invalidate;
      if (authorization !== undefined) yield* Fiber.interrupt(authorization);
    }
    // The cloud machine was readied above; pairing again must not ready it twice.
    const provisioned = yield* provisionDesktopSshEnvironment(
      bridge,
      input.target,
      input.expectedEnvironmentId,
      {
        ...progressOptions,
        ...(preparedAttachmentId === undefined ? {} : { preparedAttachmentId }),
      },
      () => Effect.void,
      grants,
    );
    const prepared: ClientCapabilities.PreparedSshEnvironment = {
      bootstrap: provisioned.bootstrap,
      bearerToken: provisioned.bearerToken,
      verifiedEndpoint: provisioned.verifiedEndpoint,
      ...(provisioned.sshPairingGrant === undefined
        ? {}
        : { sshPairingGrant: provisioned.sshPairingGrant }),
    };
    return prepared;
  },
  Effect.scoped,
);

/** New trust files must be written by the native primary backend on this Desktop's OS user. */
export function desktopOwnsSshHostConfig(
  bridge: Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined,
  primaryHttpBaseUrl: string | null,
) {
  if (bridge === undefined || primaryHttpBaseUrl === null) return false;
  try {
    const primary = bridge
      .getLocalEnvironmentBootstraps()
      .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
    return (
      primary !== undefined &&
      !primary.runningDistro &&
      typeof primary.bootstrapToken === "string" &&
      primary.bootstrapToken.length > 0 &&
      primary.httpBaseUrl === primaryHttpBaseUrl
    );
  } catch {
    return false;
  }
}

const decodeSshHostResult = Schema.decodeUnknownEffect(SshHostResult);

/** Decode owner IPC at the renderer boundary, including bridges from older desktop builds. */
export const readDesktopSshRuntime = Effect.fn("web.connectionPlatform.ssh.runtime")(function* (
  bridge: Pick<DesktopBridge, "getSshHostStatus" | "updateSshRuntime"> | undefined,
  target: DesktopSshEnvironmentTarget,
  mode?: SshRuntimeUpdateMode,
) {
  if (
    bridge === undefined ||
    (mode === undefined
      ? typeof bridge.getSshHostStatus !== "function"
      : typeof bridge.updateSshRuntime !== "function")
  ) {
    return {
      kind: "error",
      code: "unsupported",
      message: "SSH runtime updates need the desktop app that owns this SSH connection.",
    } satisfies SshHostResult;
  }
  return yield* Effect.tryPromise({
    try: () =>
      mode === undefined ? bridge.getSshHostStatus(target) : bridge.updateSshRuntime(target, mode),
    catch: sshPreparationFailure,
  }).pipe(
    Effect.flatMap(decodeSshHostResult),
    Effect.catch(() =>
      Effect.succeed({
        kind: "error",
        code: "operation_failed",
        message: `Could not read or update GOAT on ${target.alias || target.hostname}. Try again.`,
        fix: { actor: "human", instruction: "Try again" },
      } satisfies SshHostResult),
    ),
  );
});

export const desktopSshRuntimeGateway: SshRuntimeOwnerGateway = {
  status: (target) =>
    readDesktopSshRuntime(typeof window === "undefined" ? undefined : window.desktopBridge, target),
  update: (target, mode) =>
    readDesktopSshRuntime(
      typeof window === "undefined" ? undefined : window.desktopBridge,
      target,
      mode,
    ),
};

const ANALYTICS_DEVICE_ID_KEY = "goat:analytics-device-id";

// Lives as long as this browser profile's site data. Storage can be blocked, which only drops the id.
const analyticsDevice = {
  id: Effect.try(() => {
    const existing = window.localStorage.getItem(ANALYTICS_DEVICE_ID_KEY);
    if (existing) return existing;
    const created = randomUUID();
    window.localStorage.setItem(ANALYTICS_DEVICE_ID_KEY, created);
    return created;
  }).pipe(Effect.option),
};

const layerCapabilities = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientCapabilities.ClientPresentation.of({
      metadata: clientMetadata(),
    });
    const cloudSession = ClientCapabilities.CloudSession.of({
      identity: Effect.sync(() =>
        Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
      ),
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (session === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Sign in to T3 Connect to connect this environment.",
          });
        }
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "network",
                detail: error.message,
              }),
          ),
        );
        if (token === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The T3 Connect session is unavailable.",
          });
        }
        return token;
      }),
    });
    const identity = ClientCapabilities.RelayDeviceIdentity.of({
      deviceId: Effect.succeedNone,
    });
    const primaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = ClientCapabilities.SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(
        function* (target, expectedEnvironmentId, options) {
          const bridge = window.desktopBridge;
          if (bridge === undefined) {
            return yield* new ConnectionBlockedError({
              reason: "unsupported",
              detail: "SSH environments are only available in the desktop app.",
            });
          }
          return yield* provisionDesktopSshEnvironment(
            bridge,
            target,
            expectedEnvironmentId,
            options,
          );
        },
      ),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* prepareDesktopSshEnvironment(bridge, input);
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(ClientCapabilities.CloudSession, cloudSession).pipe(
      Context.add(ClientCapabilities.AnalyticsDevice, analyticsDevice),
      Context.add(ClientCapabilities.PrimaryEnvironmentAuth, primaryAuth),
      Context.add(ClientCapabilities.PrimaryConnectionEndpoint, {
        endpoint: Effect.gen(function* () {
          const target = yield* Effect.try({
            try: readPrimaryEnvironmentTarget,
            catch: () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not resolve the primary hub endpoint.",
              }),
          });
          if (target === null)
            return yield* new ConnectionBlockedError({
              reason: "configuration",
              detail: "The primary hub endpoint is unavailable.",
            });
          return {
            httpBaseUrl: target.target.httpBaseUrl,
            bearerToken: yield* primaryAuth.bearerToken,
          };
        }),
      }),
      Context.add(ClientCapabilities.RelayDeviceIdentity, identity),
      Context.add(ClientCapabilities.ClientPresentation, presentation),
      Context.add(ClientCapabilities.SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(
    Effect.provide(PrimaryEnvironmentHttpLayer.layer),
    Effect.mapError(mapRemoteEnvironmentError),
  );
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

const loadSecondaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadSecondaryConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  const bootstrapToken = entry.bootstrapToken;
  if (
    entry.httpBaseUrl === null ||
    entry.wsBaseUrl === null ||
    (bootstrapToken === undefined && entry.accessToken === undefined)
  ) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: `Desktop-local backend ${entry.id} is not ready yet.`,
    });
  }
  const httpBaseUrl = entry.httpBaseUrl;
  const wsBaseUrl = entry.wsBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const issuedAtEpochMs = yield* Clock.currentTimeMillis;
  // The desktop seed grant is administrative so the primary window can manage
  // access; a secondary backend session only needs to operate its environment.
  const access =
    bootstrapToken === undefined
      ? {
          access_token: entry.accessToken ?? "",
          expires_in: secondsUntil(entry.accessTokenExpiresAt, issuedAtEpochMs),
        }
      : yield* bootstrapRemoteBearerSession({
          httpBaseUrl,
          credential: bootstrapToken,
          scopes: AuthStandardClientScopes,
          clientMetadata: clientMetadata(),
        }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Keep the desktop pool's stable backend id in the connection id. The
  // descriptor environment id still scopes projects and RPC state, while the
  // backend id lets desktop-only operations (notably the WSL folder picker)
  // route back to the instance that owns the environment.
  const connectionId = desktopLocalConnectionId(entry.id);
  const label = entry.label || descriptor.label;
  return {
    registration: new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({ token: access.access_token }),
    }),
    expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, access.expires_in),
    refreshAtEpochMs: secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, access.expires_in),
  };
});

// Poll cadence for the desktop bootstrap topology. There is no change event on
// the bridge, so the renderer polls; successful registrations are cached by a
// signature of their endpoint until bearer credentials approach expiry.
const PLATFORM_POLL_INTERVAL = "3 seconds";
const SECONDARY_BEARER_REFRESH_SKEW_MS = 5_000;

/** Seconds from `nowEpochMs` to an ISO expiry; zero when it is missing or past. */
export function secondsUntil(expiresAt: string | undefined, nowEpochMs: number): number {
  const expiresAtEpochMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  return Number.isFinite(expiresAtEpochMs)
    ? Math.max(0, Math.floor((expiresAtEpochMs - nowEpochMs) / 1_000))
    : 0;
}

function secondaryBearerExpiresAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return issuedAtEpochMs + Math.max(0, expiresInSeconds * 1_000);
}

export function secondaryBearerRefreshAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return Math.max(
    issuedAtEpochMs,
    secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, expiresInSeconds) -
      SECONDARY_BEARER_REFRESH_SKEW_MS,
  );
}

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
  readonly refreshAtEpochMs?: number;
  /** The bootstrap token a desktop-local bearer was exchanged for, or that bearer itself. */
  readonly bootstrapToken?: string;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function canReuseCachedPlatformRegistration(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    (cached.refreshAtEpochMs === undefined || nowEpochMs < cached.refreshAtEpochMs)
  );
}

export function canRetainCachedPlatformRegistrationAfterRefreshFailure(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    cached.expiresAtEpochMs !== undefined &&
    nowEpochMs < cached.expiresAtEpochMs
  );
}

const REJECTED_BOOTSTRAP_RETRY_INITIAL_MS = 60_000;
const REJECTED_BOOTSTRAP_RETRY_MAX_MS = 30 * 60_000;

export interface RejectedSecondaryBootstrap {
  readonly signature: string;
  readonly retryAtEpochMs: number;
  readonly delayMs: number;
}

/**
 * A backend that rejected a bootstrap token will usually keep rejecting it, so
 * the poll backs off on that exact signature instead of re-presenting a dead
 * credential every few seconds. It still retries on a capped backoff: a backend
 * that restarts on the same port seeds a fresh grant for the same token, and
 * nothing in the topology says it restarted.
 */
export function isRejectedSecondaryBootstrap(
  rejected: RejectedSecondaryBootstrap | undefined,
  signature: string,
  nowEpochMs: number,
): rejected is RejectedSecondaryBootstrap {
  return (
    rejected !== undefined &&
    rejected.signature === signature &&
    nowEpochMs < rejected.retryAtEpochMs
  );
}

export function nextRejectedSecondaryBootstrap(
  previous: RejectedSecondaryBootstrap | undefined,
  signature: string,
  nowEpochMs: number,
): RejectedSecondaryBootstrap {
  const delayMs =
    previous?.signature === signature
      ? Math.min(previous.delayMs * 2, REJECTED_BOOTSTRAP_RETRY_MAX_MS)
      : REJECTED_BOOTSTRAP_RETRY_INITIAL_MS;
  return { signature, retryAtEpochMs: nowEpochMs + delayMs, delayMs };
}

export function isRejectedBootstrapCredentialError(error: ConnectionAttemptError): boolean {
  return error._tag === "ConnectionBlockedError" && error.reason === "authentication";
}

export function secondaryRegistrationsToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: DesktopSecondaryBootstrapsRead,
  nowEpochMs: number,
): ReadonlyMap<string, CachedPlatformRegistration> {
  if (topologyRead._tag === "Success") {
    return new Map();
  }
  return new Map(
    [...previous].filter(
      ([, cached]) => cached.expiresAtEpochMs !== undefined && nowEpochMs < cached.expiresAtEpochMs,
    ),
  );
}

const layerPlatformConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp() || isLocalEnvironmentDisabled()) {
      return PlatformConnectionSource.PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());
    const rejectedRef = yield* Ref.make(new Map<string, RejectedSecondaryBootstrap>());

    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target !== null) {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (
          cached !== undefined &&
          canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
        ) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          }
        }
      }

      const topologyRead = readDesktopSecondaryBootstrapsResult();
      for (const [id, cached] of secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        topologyRead,
        nowEpochMs,
      )) {
        next.set(id, cached);
        registrations.push(cached.registration);
      }

      if (topologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the desktop-local backend topology.", {
          cause: topologyRead.cause,
        });
      } else {
        const rejected = yield* Ref.get(rejectedRef);
        const nextRejected = new Map<string, RejectedSecondaryBootstrap>();
        for (const bootstrap of topologyRead.bootstraps) {
          // The cached bearer belongs to the endpoint, not to the bootstrap
          // token it was exchanged for: a new token must not drop a live
          // session (its removal also clears the environment's drafts). The
          // token only decides whether a rejected exchange is retried.
          const endpointSignature = `${bootstrap.httpBaseUrl}|${bootstrap.wsBaseUrl}`;
          const credential = bootstrap.bootstrapToken ?? bootstrap.accessToken;
          const signature = `${endpointSignature}|${credential ?? ""}`;
          const cached = previous.get(bootstrap.id);
          // A new token from the desktop means something changed (rotation, a
          // restarted backend): exchange it rather than reusing a bearer that
          // may be dead. The old bearer stays registered if that exchange fails.
          if (
            cached !== undefined &&
            cached.bootstrapToken === credential &&
            canReuseCachedPlatformRegistration(cached, endpointSignature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
            continue;
          }
          const previouslyRejected = rejected.get(bootstrap.id);
          if (isRejectedSecondaryBootstrap(previouslyRejected, signature, nowEpochMs)) {
            nextRejected.set(bootstrap.id, previouslyRejected);
            if (
              cached !== undefined &&
              canRetainCachedPlatformRegistrationAfterRefreshFailure(
                cached,
                endpointSignature,
                nowEpochMs,
              )
            ) {
              next.set(bootstrap.id, cached);
              registrations.push(cached.registration);
            }
            continue;
          }
          const built = yield* loadSecondaryConnectionRegistration(bootstrap).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not connect a desktop-local backend.", {
                id: bootstrap.id,
                error,
              }),
            ),
            Effect.tapError((error) =>
              isRejectedBootstrapCredentialError(error)
                ? // Back off from when the rejection arrived; the exchanges in
                  // this poll can take longer than the first backoff step.
                  Clock.currentTimeMillis.pipe(
                    Effect.map((rejectedAtEpochMs) =>
                      nextRejected.set(
                        bootstrap.id,
                        nextRejectedSecondaryBootstrap(
                          previouslyRejected,
                          signature,
                          rejectedAtEpochMs,
                        ),
                      ),
                    ),
                  )
                : Effect.void,
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = {
              signature: endpointSignature,
              ...(credential === undefined ? {} : { bootstrapToken: credential }),
              ...built.value,
            };
            next.set(bootstrap.id, cacheEntry);
            registrations.push(built.value.registration);
          } else if (
            cached !== undefined &&
            canRetainCachedPlatformRegistrationAfterRefreshFailure(
              cached,
              endpointSignature,
              nowEpochMs,
            )
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
          }
        }
        yield* Ref.set(rejectedRef, nextRejected);
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const layerRpcRequestObserver = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, environmentLabel, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentLabel}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof ConnectionStorage.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerCapabilities
  | typeof layerPlatformConnectionSource
  | typeof layerEnvironmentOwnedDataCleanup
  | typeof layerRpcRequestObserver;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  ConnectionStorage.layer,
  layerConnectivity,
  layerWakeups,
  layerCapabilities,
  layerPlatformConnectionSource,
  layerEnvironmentOwnedDataCleanup,
  layerRpcRequestObserver,
);
