import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";

const instanceId = ProviderInstanceId.make("managed-codex-test");

const makeRenewalBroker = Effect.gen(function* () {
  const oauthEntered = yield* Deferred.make<void>();
  const oauthRelease = yield* Deferred.make<void>();
  let pauseOAuth = false;
  const refreshTokens: string[] = [];
  const credentials = {
    clientId: "oaiapp_broker",
    subject: "broker-user",
    idToken: "broker-sign-in",
    email: null,
    accessToken: "expired-access",
    refreshToken: "single-use-refresh",
    expiresAt: 0,
    earliestRefreshAt: null,
    scopes: ["chatgpt.tokens.use.direct"],
  };
  const environmentId = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("openid-configuration")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://auth.openai.com",
            authorization_endpoint: "https://auth.openai.com/authorize",
            token_endpoint: "https://auth.openai.com/token",
            jwks_uri: "https://auth.openai.com/jwks",
          }),
        );
      }
      assert.equal(request.url, "https://auth.openai.com/token");
      assert.equal(request.body._tag, "Uint8Array");
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing refresh body");
      const body = new URLSearchParams(new TextDecoder().decode(request.body.body));
      refreshTokens.push(body.get("refresh_token")!);
      yield* Deferred.succeed(oauthEntered, undefined);
      if (pauseOAuth) yield* Deferred.await(oauthRelease);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          access_token: "renewed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "chatgpt.tokens.use.direct",
        }),
      );
    }),
  );
  return yield* Effect.gen(function* () {
    const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
    yield* store.set(new TextEncoder().encode(JSON.stringify(credentials)));
    const auth = yield* makeCodexChatGptAuth({ instanceId });
    const profileKey = yield* auth.profileKey(credentials);
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
    const context = yield* Layer.buildWithScope(CodexManagedTokenBroker.layer, scope);
    const broker = Context.get(context, CodexManagedTokenBroker.CodexManagedTokenBroker);
    const endpoint = yield* broker.endpoint;
    yield* Effect.addFinalizer(() => Deferred.succeed(oauthRelease, undefined));
    return {
      auth,
      store,
      broker,
      endpoint,
      refreshTokens,
      request: { version: 1, instanceId, environmentId, profileKey },
      oauthEntered,
      oauthRelease,
      pause: () => {
        pauseOAuth = true;
      },
    };
  }).pipe(
    Effect.provide(ServerSecretStore.layer),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  );
});

const brokerClient = (endpoint: string, request: unknown) =>
  Effect.acquireRelease(
    Effect.callback<{ socket: NodeNet.Socket; response: Promise<string> }, Error>((resume) => {
      const socket = NodeNet.createConnection(endpoint);
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        text += chunk;
      });
      const response = new Promise<string>((resolve) => socket.once("close", () => resolve(text)));
      socket.on("error", () => {});
      socket.once("error", (error) => resume(Effect.fail(error)));
      socket.once("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
        resume(Effect.succeed({ socket, response }));
      });
      return Effect.sync(() => {
        if (socket.connecting) socket.destroy();
      });
    }),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );
const provideBroker = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-renewal-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

// regression: #16132 a renewal must outlive the Codex helper that asked for it, because the
// refresh token it spends is single-use.
it.effect("server-owned renewal persists rotated credentials after the helper disconnects", () =>
  provideBroker(
    Effect.gen(function* () {
      const h = yield* makeRenewalBroker;
      h.pause();
      const client = yield* brokerClient(h.endpoint, h.request);
      yield* Deferred.await(h.oauthEntered);
      client.socket.destroy();
      yield* Effect.promise(() => client.response);
      assert.equal(Option.getOrThrow(yield* h.auth.read).refreshToken, "single-use-refresh");
      yield* Deferred.succeed(h.oauthRelease, undefined);
      yield* h.broker.awaitIdle;
      const persisted = Option.getOrThrow(yield* h.auth.read);
      assert.equal(persisted.refreshToken, "rotated-refresh");
      assert.equal((yield* h.auth.access).accessToken, "renewed-access");
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
  ),
);

it.live("the private broker refuses another environment, instance, or sign-in profile", () =>
  provideBroker(
    Effect.gen(function* () {
      const h = yield* makeRenewalBroker;
      yield* Effect.forEach(
        [
          {
            ...h.request,
            environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000002"),
          },
          { ...h.request, instanceId: ProviderInstanceId.make("another-instance") },
          { ...h.request, profileKey: "0".repeat(64) },
        ],
        (request) =>
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* brokerClient(h.endpoint, request);
              assert.equal(yield* Effect.promise(() => client.response), "");
            }),
          ),
      );
      yield* h.broker.awaitIdle;
      assert.deepEqual(h.refreshTokens, []);
      const client = yield* brokerClient(h.endpoint, h.request);
      assert.deepEqual(JSON.parse(yield* Effect.promise(() => client.response)), {
        token: "renewed-access",
      });
      yield* h.broker.awaitIdle;
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
  ),
);
