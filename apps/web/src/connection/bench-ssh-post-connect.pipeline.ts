// @effect-diagnostics nodeBuiltinImport:off - standalone benchmark owns its private credential file at the process boundary.
import * as NodeFSP from "node:fs/promises";
import { AuthStandardClientScopes, type DesktopBridge } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import { prepareDesktopSshEnvironment } from "./platform.ts";
import * as Authorization from "@goat/client-runtime/authorization/service";
import {
  TokenStore,
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@goat/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@goat/client-runtime/environment";
import { ClientCapabilities as Capabilities } from "@goat/client-runtime/platform";
import { ManagedRelay as Relay } from "@goat/client-runtime/relay";
import * as RpcHttp from "@goat/client-runtime/rpc";
import * as Session from "@goat/client-runtime/rpc/session";
import * as Driver from "@goat/client-runtime/connection/driver";
import * as Resolver from "@goat/client-runtime/connection/resolver";
import {
  BearerConnectionCredential,
  CredentialStore as Credentials,
  ProfileStore as Profiles,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@goat/client-runtime/connection";

export async function run(input: {
  upstream: string;
  httpBaseUrl: string;
  bearerFile: string;
  pairingCredential?: string | null;
  runs: number;
}) {
  const httpLayer = RpcHttp.layerRemoteHttpClient(globalThis.fetch);
  const runHttp = <A, E>(
    effect: Effect.Effect<A, E, import("effect/http/HttpClient").HttpClient>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(httpLayer)));
  const descriptor = await runHttp(
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl: input.upstream }),
  );
  let bearerToken: string;
  try {
    bearerToken = (await NodeFSP.readFile(input.bearerFile, "utf8")).trim();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    if (!input.pairingCredential)
      throw new Error("A fresh dev log is required to initialize the bearer file.", {
        cause: error,
      });
    const access = await runHttp(
      bootstrapRemoteBearerSession({
        httpBaseUrl: input.upstream,
        credential: input.pairingCredential,
      }),
    );
    bearerToken = access.access_token;
    await NodeFSP.writeFile(input.bearerFile, bearerToken, { mode: 0o600 });
  }
  const session = await runHttp(
    fetchRemoteSessionState({ httpBaseUrl: input.upstream, bearerToken }),
  );
  if (
    !session.authenticated ||
    !AuthStandardClientScopes.every((scope) =>
      (session.permissions ?? session.scopes ?? []).includes(scope),
    )
  ) {
    throw new Error("The isolated server must grant all standard client scopes.");
  }
  const target = { alias: "benchmark", hostname: "127.0.0.1", username: "benchmark", port: 22 };
  const connectionId = "ssh-latency-benchmark";
  const profile = new SshConnectionProfile({
    connectionId,
    environmentId: descriptor.environmentId,
    label: "SSH latency benchmark",
    target,
  });
  const entry = {
    target: new SshConnectionTarget({
      connectionId,
      environmentId: descriptor.environmentId,
      label: profile.label,
    }),
    profile: Option.some(profile),
    enabled: true,
  };
  const results: Array<{
    run: number;
    totalMs: number;
    websocketOpenMs: number;
    initialSnapshotMs: number;
    requests: Array<{ step: string; wallMs: number }>;
    environmentMatches: boolean;
  }> = [];
  for (let run = 1; run <= input.runs; run++) {
    const requests: Array<{ step: string; wallMs: number }> = [];
    let websocketOpenMs = 0;
    let openedAt = 0;
    const fetchFn: typeof fetch = async (request, init) => {
      const path = new URL(String(request)).pathname;
      const started = performance.now();
      const response = await fetch(request, init);
      requests.push({
        step: path.endsWith("/environment")
          ? "descriptor"
          : path.endsWith("/session")
            ? "session"
            : path.endsWith("/websocket-ticket")
              ? "ticket"
              : "other-http",
        wallMs: performance.now() - started,
      });
      return response;
    };
    const measuredHttp = RpcHttp.layerRemoteHttpClient(fetchFn);
    const runMeasuredHttp = <A, E>(
      effect: Effect.Effect<A, E, import("effect/http/HttpClient").HttpClient>,
    ) => Effect.runPromise(effect.pipe(Effect.provide(measuredHttp)));
    const bridge = {
      ensureSshEnvironment: async () => ({
        target,
        httpBaseUrl: input.httpBaseUrl,
        wsBaseUrl: input.httpBaseUrl.replace("http:", "ws:"),
        pairingToken: null,
      }),
      fetchSshEnvironmentDescriptor: (httpBaseUrl: string) =>
        runMeasuredHttp(fetchRemoteEnvironmentDescriptor({ httpBaseUrl })),
      fetchSshSessionState: (httpBaseUrl: string, token: string) =>
        runMeasuredHttp(fetchRemoteSessionState({ httpBaseUrl, bearerToken: token })),
    } as unknown as DesktopBridge;
    const unused = () => Effect.die("Unexpected relay operation in SSH benchmark");
    const dependencies = Layer.mergeAll(
      measuredHttp,
      Layer.succeed(Capabilities.PrimaryEnvironmentAuth, { bearerToken: Effect.succeedNone }),
      Layer.succeed(Capabilities.ClientPresentation, {
        metadata: { label: "SSH latency benchmark", deviceType: "desktop", surface: "desktop" },
      }),
      Layer.succeed(Capabilities.CloudSession, {
        identity: Effect.succeedNone,
        clerkToken: Effect.die("unused"),
      }),
      Layer.succeed(Capabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
      Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
        get: () => Effect.succeedNone,
        put: unused,
        remove: unused,
      }),
      Layer.succeed(Relay.ManagedRelayDpopSigner, {
        thumbprint: Effect.die("unused"),
        createProof: unused,
      }),
      Layer.succeed(Relay.ManagedRelayClient, {
        relayUrl: "https://unused.invalid",
        listEnvironments: unused,
        listDevices: unused,
        createEnvironmentLinkChallenge: unused,
        linkEnvironment: unused,
        unlinkEnvironment: unused,
        getEnvironmentStatus: unused,
        connectEnvironment: unused,
        registerDevice: unused,
        unregisterDevice: unused,
        registerLiveActivity: unused,
        getAgentActivitySnapshot: unused,
        resetTokenCache: Effect.void,
        requestKeyReadmission: () => Effect.void,
      }),
      Layer.succeed(Capabilities.SshEnvironmentGateway, {
        prepare: (request) =>
          prepareDesktopSshEnvironment(bridge, request, () => Effect.void, new Map()),
        provision: unused,
        disconnect: () => Effect.void,
      }),
      Layer.succeed(Profiles.ConnectionProfileStore, {
        get: () => Effect.succeedSome(profile),
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
      Layer.succeed(Credentials.ConnectionCredentialStore, {
        get: () => Effect.succeedSome(new BearerConnectionCredential({ token: bearerToken })),
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
    );
    const authLayer = Authorization.layer.pipe(Layer.provide(dependencies));
    const resolverLayer = Resolver.layer.pipe(Layer.provide(Layer.merge(dependencies, authLayer)));
    const sessionLayer = Session.layer({}).pipe(
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor, (url) => {
          const started = performance.now();
          const socket = new WebSocket(url);
          socket.addEventListener("open", () => {
            openedAt = performance.now();
            websocketOpenMs = openedAt - started;
          });
          return socket;
        }),
      ),
    );
    const driverLayer = Driver.layer.pipe(
      Layer.provide(Layer.mergeAll(measuredHttp, resolverLayer, sessionLayer)),
    );
    const started = performance.now();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* Driver.ConnectionDriver;
          const lease = yield* driver.connect(entry, () => Effect.void);
          const readyAt = performance.now();
          // The real config snapshot, including its identity check, must have arrived.
          const config = yield* lease.session.initialConfig;
          return {
            run,
            totalMs: readyAt - started,
            websocketOpenMs,
            initialSnapshotMs: readyAt - openedAt,
            requests,
            environmentMatches: config.environment.environmentId === descriptor.environmentId,
          };
        }).pipe(Effect.provide(driverLayer), Effect.timeout("30 seconds")),
      ),
    );
    results.push(result);
  }
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const first = results[0];
  if (first === undefined) throw new Error("No benchmark runs completed.");
  return {
    medians: {
      totalMs: median(results.map((r) => r.totalMs)),
      websocketOpenMs: median(results.map((r) => r.websocketOpenMs)),
      initialSnapshotMs: median(results.map((r) => r.initialSnapshotMs)),
      http: Array.from(
        new Set(results.flatMap((r) => r.requests.map((request) => request.step))),
      ).map((step) => ({
        step,
        count: first.requests.filter((r) => r.step === step).length,
        wallMs: median(
          results.flatMap((r) =>
            r.requests.filter((request) => request.step === step).map((request) => request.wallMs),
          ),
        ),
      })),
    },
    results,
  };
}
