import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthHubProxyScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  hubProxyEffectiveScopes,
  HUB_PROXY_NODE_SCOPE_CEILING,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const DESKTOP_TOKEN = "desktop-bootstrap-token-for-hub-delegation";
const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const makeRoutes = (input: { readonly hubEnabled: boolean; readonly devToken?: boolean }) => {
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: input.devToken ? "web" : "desktop",
        desktopBootstrapToken: DESKTOP_TOKEN,
        ...(input.devToken
          ? { devUrl: new URL("http://127.0.0.1:5173"), devAuthToken: Redacted.make(DEV_TOKEN) }
          : {}),
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-hub-delegation-" })));
  const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
  );
  return HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provide(ServerSettingsService.layerTest({ hub: { enabled: input.hubEnabled } })),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Handler = ReturnType<typeof HttpRouter.toWebHandler>;

const client = (web: Handler) => {
  const call = (request: Request) => web.handler(request);
  const exchange = async (credential: string) => {
    const response = await call(
      new Request("http://127.0.0.1/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { access_token: string }).access_token;
  };
  const headers = (token: string): Record<string, string> =>
    token.startsWith("cookie:") ? { cookie: token.slice(7) } : { authorization: `Bearer ${token}` };
  /** The dev token signs in through a browser cookie, as the dev web client does. */
  const browserSession = async (credential: string) => {
    const response = await call(
      new Request("http://127.0.0.1/api/auth/browser-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeJson({ credential }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .find((entry) => !entry.includes("Max-Age=0"))
      ?.split(";", 1)[0];
    return `cookie:${cookie ?? ""}`;
  };
  const pair = (token: string, scopes?: ReadonlyArray<AuthEnvironmentScope>) =>
    call(
      new Request("http://127.0.0.1/api/auth/pairing-token", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers(token) },
        body: encodeJson(scopes ? { label: "Phone", scopes } : { label: "Phone" }),
      }),
    );
  const session = async (token: string) => {
    const response = await call(
      new Request("http://127.0.0.1/api/auth/session", { headers: headers(token) }),
    );
    return (await response.json()) as {
      readonly permissions?: ReadonlyArray<AuthEnvironmentScope>;
      readonly canDelegateHubProxy?: boolean;
    };
  };
  /** Pairs a device the way a scanned QR does and returns that device's bearer. */
  const pairDevice = async (owner: string, scopes?: ReadonlyArray<AuthEnvironmentScope>) => {
    const response = await pair(owner, scopes);
    expect(response.status).toBe(200);
    return exchange(((await response.json()) as { credential: string }).credential);
  };
  return { exchange, browserSession, pair, session, pairDevice };
};

const withRoutes = (
  input: { readonly hubEnabled: boolean; readonly devToken?: boolean },
  use: (api: ReturnType<typeof client>) => Promise<void>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(makeRoutes(input), { disableLogger: true })),
    (web) => Effect.tryPromise(() => use(client(web))),
    (web) => Effect.promise(() => web.dispose()),
  ).pipe(Effect.provide(NodeServices.layer));

const withHubProxy = [...AuthStandardClientScopes, AuthHubProxyScope];

it.effect("an owner session on a hub issues a pairing that reaches hub nodes", () =>
  withRoutes({ hubEnabled: true }, async (api) => {
    const owner = await api.exchange(DESKTOP_TOKEN);
    expect((await api.session(owner)).canDelegateHubProxy).toBe(true);
    const phone = await api.pairDevice(owner, withHubProxy);
    const permissions = (await api.session(phone)).permissions ?? [];
    expect(permissions).toContain(AuthHubProxyScope);
    expect(hubProxyEffectiveScopes(permissions)).toEqual(HUB_PROXY_NODE_SCOPE_CEILING);

    const narrow = await api.pairDevice(owner, [AuthOrchestrationReadScope, AuthHubProxyScope]);
    expect(hubProxyEffectiveScopes((await api.session(narrow)).permissions ?? [])).toEqual([
      AuthOrchestrationReadScope,
    ]);
  }),
);

it.effect("an owner pairing without hub access keeps the standard scopes", () =>
  withRoutes({ hubEnabled: true }, async (api) => {
    const owner = await api.exchange(DESKTOP_TOKEN);
    const phone = await api.pairDevice(owner);
    expect((await api.session(phone)).permissions).toEqual(AuthStandardClientScopes);
  }),
);

it.effect("hub access is refused while the hub is off", () =>
  withRoutes({ hubEnabled: false }, async (api) => {
    const owner = await api.exchange(DESKTOP_TOKEN);
    const refused = await api.pair(owner, withHubProxy);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "hub_off" });
    expect((await api.pair(owner)).status).toBe(200);
  }),
);

it.effect("a paired device cannot grant hub access, even one that holds it", () =>
  withRoutes({ hubEnabled: true }, async (api) => {
    const owner = await api.exchange(DESKTOP_TOKEN);
    const standard = await api.pairDevice(owner);
    expect((await api.session(standard)).canDelegateHubProxy).toBeUndefined();
    expect((await api.pair(standard, withHubProxy)).status).toBe(403);

    const hubPhone = await api.pairDevice(owner, withHubProxy);
    expect((await api.session(hubPhone)).canDelegateHubProxy).toBeUndefined();
    expect((await api.pair(hubPhone, withHubProxy)).status).toBe(403);
    expect((await api.pair(hubPhone)).status).toBe(200);
  }),
);

it.effect("the reusable dev token does not count as the owner", () =>
  withRoutes({ hubEnabled: true, devToken: true }, async (api) => {
    const dev = await api.browserSession(DEV_TOKEN);
    expect((await api.session(dev)).canDelegateHubProxy).toBeUndefined();
    expect((await api.pair(dev, withHubProxy)).status).toBe(403);
    expect((await api.pair(dev)).status).toBe(200);
  }),
);
