import {
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor as DescriptorSchema,
} from "@goat/contracts";
import { HubProxyAuthSource } from "./hubProxyAuthSource.ts";
import { hubProxyHttpBaseUrl, requestHubProxyJson } from "./hubProxyHttp.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type {
  AuthClientPresentationMetadata,
  ExecutionEnvironmentDescriptor,
  DesktopSshPreparationProgress,
  DesktopSshAttemptContext,
} from "@goat/contracts";
import { withRelayClientTracing } from "@goat/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import {
  appendClientConnectionParams,
  type ClientOwnerParams,
  readClientOwnerParams,
} from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  profileMissingError,
} from "./errors.ts";
import {
  PullRequestRoutingPermissions,
  pullRequestRoutingConnectionKey,
} from "./pullRequestRoutingPermissions.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { credentialConnectionId } from "./routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { withSshConnectionTiming } from "./sshTiming.ts";

export interface SshPreparationOptions {
  readonly attemptContext?: DesktopSshAttemptContext;
  readonly onPreparationProgress?: (progress: DesktopSshPreparationProgress) => Effect.Effect<void>;
}

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
      onHostAnswered?: Effect.Effect<void>,
      options?: SshPreparationOptions,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
    /**
     * Authorizes a socket without the orchestration protocol gate, for hosts
     * too old to connect normally. Only update RPCs may run over it.
     */
    readonly prepareForUpdate: (entry: ConnectionCatalogEntry) => Effect.Effect<
      {
        readonly prepared: PreparedConnection;
        readonly descriptor: ExecutionEnvironmentDescriptor;
      },
      ConnectionAttemptError
    >;
  }
>()("@goat/client-runtime/connection/resolver/ConnectionResolver") {}

const decodeHubDescriptor = Schema.decodeUnknownEffect(Schema.toCodecJson(DescriptorSchema));
const decodeHubTicket = Schema.decodeUnknownEffect(Schema.toCodecJson(AuthWebSocketTicketResult));

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const sameBearerCredential = Schema.toEquivalence(BearerConnectionCredential);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(
  target: PrimaryConnectionTarget,
  clientMetadata: AuthClientPresentationMetadata | undefined,
  owners: ClientOwnerParams,
): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  appendClientConnectionParams(url, clientMetadata, "direct", owners);
  return url.toString();
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target, presentation.metadata, yield* readClientOwnerParams),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
      connectionMethod: "direct",
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    if (profile.authorization === "t3-connect") {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
        directEndpoint: { httpBaseUrl: profile.httpBaseUrl, wsBaseUrl: profile.wsBaseUrl },
      });
      return { ...authorized, target } satisfies PreparedConnection;
    }
    const credential = yield* credentials.get(credentialConnectionId(target.connectionId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearerToken: credential.token,
      connectionMethod: "direct",
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

const makeRelayBroker = Effect.fn("clientRuntime.connection.broker.makeRelay")(function* () {
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
      });
      return {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: authorized.httpAuthorization,
        target,
      } satisfies PreparedConnection;
    },
    Effect.withSpan("clientRuntime.connection.broker.relay"),
    withRelayClientTracing,
  );
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
    onHostAnswered?: Effect.Effect<void>,
    options?: SshPreparationOptions,
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    // Each pairing adds a session on the host, so connects reuse the saved token.
    const saved = Option.getOrUndefined(yield* credentials.get(target.connectionId));
    const savedToken = saved !== undefined && isBearerCredential(saved) ? saved.token : undefined;
    const authorize = (
      prepared: ClientCapabilities.PreparedSshEnvironment,
      onEndpointVerified?: Parameters<
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["onEndpointVerified"],
    ) =>
      remote
        .authorizeBearer({
          expectedEnvironmentId: target.environmentId,
          httpBaseUrl: prepared.bootstrap.httpBaseUrl,
          wsBaseUrl: prepared.bootstrap.wsBaseUrl,
          bearerToken: prepared.bearerToken,
          connectionMethod: "ssh",
          ...(onEndpointVerified === undefined ? {} : { onEndpointVerified }),
          ...(prepared.verifiedEndpoint === undefined
            ? {}
            : { verifiedSshEndpoint: prepared.verifiedEndpoint }),
        })
        .pipe(withSshConnectionTiming("authorization"));
    const prepared = yield* ssh.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
      ...(savedToken === undefined ? {} : { bearerToken: savedToken }),
      ...(onHostAnswered === undefined ? {} : { onHostAnswered }),
      ...(options?.onPreparationProgress === undefined
        ? {}
        : { onPreparationProgress: options.onPreparationProgress }),
      ...(options?.attemptContext === undefined ? {} : { attemptContext: options.attemptContext }),
      authorize,
    });
    const preparedCredential = new BearerConnectionCredential({
      token: prepared.bearerToken,
      ...(prepared.sshPairingGrant === undefined
        ? {}
        : { sshPairingGrant: prepared.sshPairingGrant }),
    });
    if (saved === undefined || !sameBearerCredential(preparedCredential, saved)) {
      yield* credentials.put(target.connectionId, preparedCredential, savedToken ?? null);
    }
    const preparedProfile = new SshConnectionProfile({
      connectionId: profile.connectionId,
      environmentId: profile.environmentId,
      label: profile.label,
      target: prepared.bootstrap.target,
    });
    if (
      pullRequestRoutingConnectionKey(entry) !==
      pullRequestRoutingConnectionKey({ ...entry, profile: Option.some(preparedProfile) })
    ) {
      const permissions = yield* PullRequestRoutingPermissions;
      yield* permissions.forget(target.environmentId);
    }
    yield* profiles.put(preparedProfile);
    const authorized = prepared.authorization ?? (yield* authorize(prepared));
    return {
      prepared: {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: authorized.httpAuthorization,
        target,
      } satisfies PreparedConnection,
      verifiedEndpoint: authorized.verifiedEndpoint,
    };
  });
});

/** @public */
export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const relay = yield* makeRelayBroker();
  const ssh = yield* makeSshBroker();
  const httpClient = yield* HttpClient.HttpClient;
  const hubAuth = yield* Effect.serviceOption(HubProxyAuthSource);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const hubProxy = Effect.fn("ConnectionResolver.hubProxy")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const profile = Option.getOrNull(entry.profile);
    if (
      profile?._tag !== "HubProxyConnectionProfile" ||
      profile.environmentId !== entry.target.environmentId ||
      entry.target._tag !== "HubProxyConnectionTarget" ||
      profile.connectionId !== entry.target.connectionId
    ) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "The hub proxy profile is unavailable or does not match the node.",
      });
    }
    if (Option.isNone(hubAuth))
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Hub proxy authorization is unavailable on this client.",
      });
    const auth = yield* hubAuth.value.resolve(profile);
    const httpBaseUrl = hubProxyHttpBaseUrl(auth.httpBaseUrl, profile.nodeId);
    const descriptor = yield* requestHubProxyJson(
      auth,
      environmentEndpointUrl(httpBaseUrl, "/.well-known/goat/environment"),
      decodeHubDescriptor,
    );
    if (descriptor.environmentId !== entry.target.environmentId)
      return yield* environmentMismatchError({
        expected: entry.target.environmentId,
        actual: descriptor.environmentId,
      });
    const ticket = yield* requestHubProxyJson(
      auth,
      environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket"),
      decodeHubTicket,
      "POST",
    );
    const socket = new URL(environmentEndpointUrl(httpBaseUrl, "/ws"));
    socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
    socket.searchParams.set("wsTicket", ticket.ticket);
    appendClientConnectionParams(socket, presentation.metadata, "direct");
    return {
      descriptor,
      prepared: {
        environmentId: entry.target.environmentId,
        label: entry.target.label,
        target: entry.target,
        httpBaseUrl,
        socketUrl: socket.toString(),
        httpAuthorization: auth.authorization,
      } satisfies PreparedConnection,
    };
  });

  const authorize = Effect.fn("clientRuntime.connection.broker.authorize")(function* (
    entry: ConnectionCatalogEntry,
    onHostAnswered?: Effect.Effect<void>,
    options?: SshPreparationOptions,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    if (target._tag === "HubProxyConnectionTarget")
      return yield* hubProxy(entry).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const { prepared, verifiedEndpoint } = yield* (() => {
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return primary(target).pipe(
            Effect.map((prepared) => ({ prepared, verifiedEndpoint: undefined })),
          );
        case "BearerConnectionTarget":
          return bearer({ ...entry, target }).pipe(
            Effect.map((prepared) => ({ prepared, verifiedEndpoint: undefined })),
          );
        case "RelayConnectionTarget":
          return relay(target).pipe(
            Effect.map((prepared) => ({ prepared, verifiedEndpoint: undefined })),
          );
        case "SshConnectionTarget":
          return ssh({ ...entry, target }, onHostAnswered, options);
      }
    })();
    const descriptor =
      verifiedEndpoint?.httpBaseUrl === prepared.httpBaseUrl
        ? verifiedEndpoint.descriptor
        : yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: prepared.httpBaseUrl,
          }).pipe(
            Effect.mapError(mapRemoteEnvironmentError),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { prepared, descriptor };
  });

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
    onHostAnswered?: Effect.Effect<void>,
    options?: SshPreparationOptions,
  ) {
    const { prepared, descriptor } = yield* authorize(entry, onHostAnswered, options);
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }
    return {
      ...prepared,
      socketUrl: appendOrchestrationProtocol(prepared.socketUrl),
    };
  });

  return ConnectionResolver.of({ prepare, prepareForUpdate: authorize });
});

export const layer = Layer.effect(ConnectionResolver, make);
