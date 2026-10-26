import { vi } from "vite-plus/test";
import { HubProxyAuthSource } from "./hubProxyAuthSource.ts";
import { HubProxyConnectionTarget } from "./model.ts";
import { HubProxyConnectionProfile } from "./catalog.ts";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type DesktopSshEnvironmentTarget,
  type DesktopSshPreparationProgress,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  putConnectionCredentialInCatalog,
} from "../platform/storageDocument.ts";
import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  PullRequestRoutingPermissions,
  pullRequestRoutingConnectionKey,
  makePullRequestRoutingPermissions,
} from "./pullRequestRoutingPermissions.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "development",
  hostname: "development.example.test",
  username: "developer",
  port: 22,
};

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile, enabled: true };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly hubAuth?: HubProxyAuthSource["Service"];
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly profileStore?: ConnectionProfileStore.ConnectionProfileStore["Service"];
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly credentialStore?: ConnectionCredentialStore.ConnectionCredentialStore["Service"];
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly primaryBearerToken?: string;
  readonly prepareSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"];
  readonly descriptorProtocolVersion?: number | null | undefined;
  readonly fetch?: typeof fetch;
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
    authorizeDpop:
      options?.authorizeDpop ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized relay environment",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: "dpop-access-token",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        })),
    authorizeDpopHttp: () => Effect.die("unused"),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die("unused"),
    prepare:
      options?.prepareSsh ??
      (() =>
        Effect.succeed({
          bootstrap: {
            target: SSH_TARGET,
            httpBaseUrl: "http://127.0.0.1:4010",
            wsBaseUrl: "ws://127.0.0.1:4010",
            pairingToken: null,
          },
          bearerToken: "ssh-bearer",
        })),
    disconnect: () => Effect.void,
  });

  const layerDependencies = Layer.mergeAll(
    options?.hubAuth === undefined
      ? Layer.empty
      : Layer.succeed(HubProxyAuthSource, options.hubAuth),
    RpcHttp.layerRemoteHttpClient(
      options?.fetch ??
        ((() =>
          Promise.resolve(
            Response.json({
              environmentId: ENVIRONMENT_ID,
              label: "Compatible environment",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0-test",
              ...(options?.descriptorProtocolVersion === undefined
                ? { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
                : options.descriptorProtocolVersion === null
                  ? {}
                  : { orchestrationProtocolVersion: options.descriptorProtocolVersion }),
              capabilities: { repositoryIdentity: true },
            }),
          )) satisfies typeof fetch),
    ),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      options?.profileStore ?? profileStore,
    ),
    Layer.succeed(
      ConnectionCredentialStore.ConnectionCredentialStore,
      options?.credentialStore ?? credentialStore,
    ),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { label: "Test Client", deviceType: "desktop", surface: "web" },
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provideMerge(layerDependencies)));
});

describe("ConnectionResolver", () => {
  it.effect.each(["compatible", "older-runtime", "restarted"] as const)(
    "uses verified SSH discovery for the protocol gate (%s)",
    (scenario) =>
      Effect.gen(function* () {
        let attempts = 0;
        const target = new SshConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          target: SSH_TARGET,
        });
        const layerBroker = yield* makeDependencies({
          fetch: () => Promise.reject(new Error("Duplicate descriptor request")),
          prepareSsh: () =>
            Effect.sync(() => {
              attempts += 1;
              return {
                bootstrap: {
                  target: SSH_TARGET,
                  httpBaseUrl: ENDPOINT.httpBaseUrl,
                  wsBaseUrl: ENDPOINT.wsBaseUrl,
                  pairingToken: null,
                },
                bearerToken: "ssh-token",
                verifiedEndpoint: {
                  httpBaseUrl: ENDPOINT.httpBaseUrl,
                  descriptor: {
                    environmentId: ENVIRONMENT_ID,
                    label: "SSH",
                    platform: { os: "linux", arch: "arm64" },
                    serverVersion: "0.0.0-test",
                    instanceId: `instance-${attempts}`,
                    ...(scenario === "older-runtime" || (scenario === "restarted" && attempts > 1)
                      ? {}
                      : { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }),
                    capabilities: { repositoryIdentity: true },
                  },
                },
              };
            }),
          authorizeBearer: (input) =>
            Effect.succeed({
              environmentId: input.expectedEnvironmentId,
              label: "SSH",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: `${ENDPOINT.wsBaseUrl}/ws`,
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
              ...(input.verifiedSshEndpoint === undefined
                ? {}
                : { verifiedEndpoint: input.verifiedSshEndpoint }),
            }),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        const entry = catalogEntry(target, Option.some(profile));
        if (scenario === "older-runtime") {
          expect(yield* broker.prepare(entry).pipe(Effect.flip)).toMatchObject({
            reason: "unsupported",
          });
          // The update path still receives discovery, even when normal RPC is unsupported.
          expect((yield* broker.prepareForUpdate(entry)).descriptor.instanceId).toBe("instance-2");
        } else {
          expect((yield* broker.prepare(entry)).socketUrl).toContain("orchestrationProtocol=");
          if (scenario === "restarted") {
            expect(yield* broker.prepare(entry).pipe(Effect.flip)).toMatchObject({
              reason: "unsupported",
            });
          }
        }
      }),
  );

  it.effect("blocks an old host during discovery before opening orchestration RPC", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({ descriptorProtocolVersion: null });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("Update GOAT on Compatible environment");
    }),
  );

  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl: `ws://127.0.0.1:3777/ws?clientSurface=web&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("delegates SSH launch to the platform gateway before remote authorization", () =>
    Effect.gen(function* () {
      const preparedTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);
      const connectionMethods = yield* Ref.make<ReadonlyArray<string>>([]);
      const answered = yield* Ref.make(false);
      const phases: DesktopSshPreparationProgress[] = [];
      const phase: DesktopSshPreparationProgress = {
        operationId: "resolver-flight",
        phase: "uploading",
        hostAnswered: true,
        remainingMs: 800_000,
      };
      const attemptContext = { supervisorId: "resolver-owner", attemptId: 2, routeId: "ssh-1" };
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const layerBroker = yield* makeDependencies({
        prepareSsh: (input) =>
          Ref.update(preparedTargets, (values) => [...values, input.target]).pipe(
            Effect.andThen(Effect.sync(() => expect(input.attemptContext).toEqual(attemptContext))),
            Effect.andThen(input.onHostAnswered ?? Effect.void),
            Effect.andThen(input.onPreparationProgress?.(phase) ?? Effect.void),
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          ),
        authorizeBearer: (input) =>
          Ref.update(connectionMethods, (methods) => [...methods, input.connectionMethod]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "SSH",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=bearer",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));

      expect(
        (yield* broker.prepare(
          catalogEntry(target, Option.some(profile)),
          Ref.set(answered, true),
          {
            attemptContext,
            onPreparationProgress: (progress) =>
              Effect.sync(() => {
                phases.push(progress);
              }),
          },
        )).socketUrl,
      ).toContain("wsTicket=bearer");
      expect(yield* Ref.get(answered)).toBe(true);
      expect(phases).toEqual([phase]);
      expect(yield* Ref.get(preparedTargets)).toEqual([SSH_TARGET]);
      expect(yield* Ref.get(connectionMethods)).toEqual(["ssh"]);
    }),
  );

  it.effect("offers the saved SSH token on each connect and saves the one it gets back", () =>
    Effect.gen(function* () {
      const offeredTokens = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["ssh-1", new BearerConnectionCredential({ token: "revoked-token" })]],
        // The host accepts only the token it paired last; anything else pairs again.
        prepareSsh: (input) =>
          Ref.update(offeredTokens, (tokens) => [...tokens, input.bearerToken]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "paired-token",
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const entry = catalogEntry(target, Option.some(profile));

      const first = yield* broker.prepare(entry);
      const second = yield* broker.prepare(entry);

      expect(yield* Ref.get(offeredTokens)).toEqual(["revoked-token", "paired-token"]);
      expect(first.httpAuthorization).toMatchObject({ token: "paired-token" });
      expect(second.httpAuthorization).toMatchObject({ token: "paired-token" });
    }),
  );

  it.effect.each(["add", "remove"] as const)(
    "saves a grant %s even if the SSH token stays the same",
    (change) =>
      Effect.gen(function* () {
        const grant = { key: "fixture-host-runtime", scopes: ["orchestration:read"] };
        const target = new SshConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          target: SSH_TARGET,
        });
        const layerBroker = yield* makeDependencies({
          credentials: [
            [
              target.connectionId,
              new BearerConnectionCredential({
                token: "paired-token",
                ...(change === "remove" ? { sshPairingGrant: grant } : {}),
              }),
            ],
          ],
          prepareSsh: () =>
            Effect.succeed({
              bootstrap: {
                target: SSH_TARGET,
                httpBaseUrl: ENDPOINT.httpBaseUrl,
                wsBaseUrl: ENDPOINT.wsBaseUrl,
                pairingToken: null,
              },
              bearerToken: "paired-token",
              ...(change === "add" ? { sshPairingGrant: grant } : {}),
            }),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        yield* broker.prepare(catalogEntry(target, Option.some(profile)));
        const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore.pipe(
          Effect.provide(layerBroker),
        );
        const saved = Option.getOrThrow(yield* credentials.get(target.connectionId));
        expect(saved.sshPairingGrant).toEqual(change === "add" ? grant : undefined);
      }),
  );

  it.effect("does not overwrite a newer pairing when an older reconnect removes metadata", () =>
    Effect.gen(function* () {
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh:fixture",
      });
      const profile = new SshConnectionProfile({
        connectionId: target.connectionId,
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const grant = { key: "fixture-host-runtime", scopes: ["orchestration:read"] };
      const newer = new BearerConnectionCredential({
        token: "new-fixture-token",
        sshPairingGrant: grant,
      });
      let document = {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        targets: [target],
        credentials: [
          {
            connectionId: target.connectionId,
            credential: new BearerConnectionCredential({
              token: "old-fixture-token",
              sshPairingGrant: grant,
            }),
          },
        ],
      };
      const layerBroker = yield* makeDependencies({
        credentialStore: {
          get: () => Effect.sync(() => Option.some(document.credentials[0]!.credential)),
          put: (connectionId, credential, expectedToken) =>
            Effect.sync(() => {
              const next = putConnectionCredentialInCatalog(
                document,
                connectionId,
                credential,
                expectedToken,
              );
              document = { ...next, targets: [target], credentials: [...next.credentials] };
            }),
          remove: () => Effect.die("unused"),
        },
        prepareSsh: () =>
          Effect.sync(() => {
            document.credentials = [{ connectionId: target.connectionId, credential: newer }];
            return {
              bootstrap: {
                target: SSH_TARGET,
                httpBaseUrl: ENDPOINT.httpBaseUrl,
                wsBaseUrl: ENDPOINT.wsBaseUrl,
                pairingToken: null,
              },
              bearerToken: "old-fixture-token",
            };
          }),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      yield* broker.prepare(catalogEntry(target, Option.some(profile)));
      expect(document.credentials[0]!.credential).toEqual(newer);
    }),
  );

  it.effect.each(["unchanged", "changed", "revocation-failed"] as const)(
    "handles %s SSH routing consent before saving or authorizing",
    (scenario) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const target = new SshConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          target: SSH_TARGET,
        });
        const entry = catalogEntry(target, Option.some(profile));
        const preparedTarget =
          scenario === "unchanged"
            ? SSH_TARGET
            : { ...SSH_TARGET, hostname: "replacement.example.test" };
        const failure = new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Could not persist routing consent.",
        });
        const permissions = yield* makePullRequestRoutingPermissions({
          read: Effect.succeed([
            {
              environmentId: ENVIRONMENT_ID,
              connectionKey: pullRequestRoutingConnectionKey(entry)!,
              permission: "read-write",
            },
          ]),
          write: () =>
            Effect.sync(() => {
              calls.push("revoke");
            }).pipe(
              Effect.andThen(scenario === "revocation-failed" ? Effect.fail(failure) : Effect.void),
            ),
        });
        let savedProfile: ConnectionProfile = profile;
        const layerBroker = yield* makeDependencies({
          profileStore: {
            get: () => Effect.sync(() => Option.some(savedProfile)),
            put: (value) =>
              Effect.sync(() => {
                calls.push("profile");
                savedProfile = value;
              }),
            remove: () => Effect.die("unused"),
          },
          prepareSsh: () =>
            Effect.succeed({
              bootstrap: {
                target: preparedTarget,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          authorizeBearer: (input) =>
            Effect.sync(() => {
              calls.push("authorize");
              return {
                environmentId: input.expectedEnvironmentId,
                label: "SSH",
                httpBaseUrl: input.httpBaseUrl,
                socketUrl: "ws://127.0.0.1:4010/ws?wsTicket=ssh",
                httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
              };
            }),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        const prepare = broker
          .prepare(entry)
          .pipe(Effect.provideService(PullRequestRoutingPermissions, permissions));
        if (scenario === "revocation-failed") {
          expect(yield* Effect.flip(prepare)).toBe(failure);
          expect(savedProfile).toBe(profile);
          expect(calls).toEqual(["revoke"]);
        } else {
          expect((yield* prepare).socketUrl).toContain("wsTicket=ssh");
          expect(savedProfile).toMatchObject({ target: preparedTarget });
          expect(calls).toEqual(
            scenario === "unchanged"
              ? ["profile", "authorize"]
              : ["revoke", "profile", "authorize"],
          );
        }
        expect(yield* permissions.get(entry)).toBe(scenario === "changed" ? "off" : "read-write");
      }),
  );
});

describe("hub proxy preparation", () => {
  const target = new HubProxyConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Node",
    connectionId: "hub:hub:node",
  });
  const profile = new HubProxyConnectionProfile({
    connectionId: target.connectionId,
    environmentId: ENVIRONMENT_ID,
    label: "Node",
    hubEnvironmentId: EnvironmentId.make("hub"),
    hubConnectionId: "primary",
    nodeId: "node/path",
  });
  const descriptor = {
    environmentId: ENVIRONMENT_ID,
    label: "Node",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: {},
  };

  it.effect.each([null, { _tag: "Bearer" as const, token: "hub-token" }])(
    "authenticates the descriptor and ticket exactly once, reuses the descriptor and preserves the node prefix (%j)",
    (authorization) =>
      Effect.gen(function* () {
        const requests: { url: string; init: RequestInit }[] = [];
        const layer = yield* makeDependencies({
          hubAuth: {
            resolve: () => Effect.succeed({ httpBaseUrl: "https://hub.test/", authorization }),
          },
          fetch: ((url, init) => {
            requests.push({ url: String(url), init: init ?? {} });
            return Promise.resolve(
              String(url).includes("websocket-ticket")
                ? Response.json({ ticket: "hub-ticket", expiresAt: "2026-10-20T00:00:00.000Z" })
                : Response.json(descriptor),
            );
          }) satisfies typeof fetch,
        });
        const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layer));
        const prepared = yield* resolver.prepare(catalogEntry(target, Option.some(profile)));
        expect(prepared.httpBaseUrl).toBe("https://hub.test/hub/nodes/node%2Fpath/");
        expect(prepared.httpAuthorization).toEqual(authorization);
        expect(requests.map((request) => request.url)).toEqual([
          "https://hub.test/hub/nodes/node%2Fpath/.well-known/goat/environment",
          "https://hub.test/hub/nodes/node%2Fpath/api/auth/websocket-ticket",
        ]);
        for (const request of requests) {
          expect(new Headers(request.init.headers).get("authorization")).toBe(
            authorization === null ? null : "Bearer hub-token",
          );
          if (authorization === null) expect(request.init.credentials).toBe("include");
        }
        const socket = new URL(prepared.socketUrl);
        expect(socket.pathname).toBe("/hub/nodes/node%2Fpath/ws");
        expect(socket.searchParams.get("wsTicket")).toBe("hub-ticket");
        expect(socket.searchParams.get("connectionMethod")).toBe("direct");
        expect(socket.searchParams.get("clientSurface")).toBe("web");
        expect(socket.searchParams.get("orchestrationProtocol")).toBe(
          String(ORCHESTRATION_PROTOCOL_VERSION),
        );
      }),
  );

  it.effect("refuses an identity mismatch before issuing a ticket", () =>
    Effect.gen(function* () {
      let calls = 0;
      const layer = yield* makeDependencies({
        hubAuth: {
          resolve: () => Effect.succeed({ httpBaseUrl: "https://hub.test", authorization: null }),
        },
        fetch: (() => {
          calls++;
          return Promise.resolve(Response.json({ ...descriptor, environmentId: "wrong-node" }));
        }) satisfies typeof fetch,
      });
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layer));
      expect(
        yield* Effect.flip(resolver.prepare(catalogEntry(target, Option.some(profile)))),
      ).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(calls).toBe(1);
    }),
  );

  it.effect.each([401, 403, 503])("classifies hub status %i", (status) =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({
        hubAuth: {
          resolve: () => Effect.succeed({ httpBaseUrl: "https://hub.test", authorization: null }),
        },
        fetch: (() =>
          Promise.resolve(
            Response.json({ message: "Unavailable" }, { status }),
          )) satisfies typeof fetch,
      });
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layer));
      expect(
        yield* Effect.flip(resolver.prepare(catalogEntry(target, Option.some(profile)))),
      ).toMatchObject({
        _tag: status === 503 ? "ConnectionTransientError" : "ConnectionBlockedError",
      });
    }),
  );
});
