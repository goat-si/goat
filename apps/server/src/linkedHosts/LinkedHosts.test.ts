import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, EnvironmentHttpApi } from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as LinkedHosts from "./LinkedHosts.ts";

class HostAuthApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const HOST = "box.example.ts.net";
const DESCRIPTOR = {
  environmentId: "env-box",
  label: "Build box",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.1.0-test",
  capabilities: { repositoryIdentity: true },
};

/**
 * Runs body against a LinkedHosts whose fetch reaches a real host's OAuth
 * routes (behind an https proxy, as over Tailscale), so linking is checked
 * against the server code that issues the session.
 */
const withHost = <A, E>(
  body: (
    hostAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  ) => Effect.Effect<A, E, LinkedHosts.LinkedHosts>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const hostConfig = ServerConfig.layerTest(process.cwd(), { prefix: "goat-linked-host-" });
    const hostAuthLayer = EnvironmentAuth.layer.pipe(
      Layer.provide(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provide(hostConfig),
    );
    let hostAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const routes = Layer.mergeAll(
      Layer.effectDiscard(
        EnvironmentAuth.EnvironmentAuth.pipe(
          Effect.tap((auth) =>
            Effect.sync(() => {
              hostAuth = auth;
            }),
          ),
        ),
      ),
      HttpApiBuilder.layer(HostAuthApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
    ).pipe(
      Layer.provideMerge(hostAuthLayer),
      Layer.provide(hostConfig),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    const requests: Array<string> = [];
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) => {
        const context = Context.make(Crypto.Crypto, crypto);
        const toHost = async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          requests.push(`${request.method} ${url.pathname}`);
          if (url.host !== HOST) throw new TypeError(`fetch failed: ${url.host}`);
          if (url.pathname === GOAT_ENVIRONMENT_PATH) return Response.json(DESCRIPTOR);
          const headers = new Headers(request.headers);
          headers.set("host", HOST);
          headers.set("x-forwarded-proto", "https");
          const body = request.method === "GET" ? undefined : await request.text();
          return web.handler(
            new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
              method: request.method,
              headers,
              ...(body === undefined ? {} : { body }),
            }),
            context,
          );
        };
        return Effect.gen(function* () {
          // The router builds its layers on the first request.
          yield* Effect.promise(() =>
            toHost(`https://${HOST}/.well-known/oauth-authorization-server`),
          );
          requests.length = 0;
          const result = yield* body(hostAuth!).pipe(
            Effect.provide(
              LinkedHosts.layer.pipe(
                Layer.provide(ServerSecretStore.layer),
                Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-linker-" })),
                Layer.provide(FetchHttpClient.layer),
                Layer.provide(Layer.succeed(FetchHttpClient.Fetch, toHost as typeof fetch)),
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          return { result, requests };
        });
      },
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const pairingCode = (auth: EnvironmentAuth.EnvironmentAuth["Service"]) =>
  auth
    .issuePairingCredential({ scopes: [...AuthStandardClientScopes] })
    .pipe(Effect.map((issued) => issued.credential));

const LINK_INPUT = {
  name: "box",
  url: `https://${HOST}`,
  code: "fixture-pairing-code",
  access: "read-only" as const,
  clientName: "test",
  beforeSave: Effect.void,
};
const STAGES = [
  { name: "descriptor", path: GOAT_ENVIRONMENT_PATH },
  { name: "registration", path: "/oauth/mcp/register" },
  { name: "decision", path: "/oauth/mcp/decision" },
  { name: "token", path: "/oauth/mcp/token" },
];
const decodeDecision = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ authorization: Schema.Struct({ state: Schema.String }) })),
);

const exchangeResponse = (request: HttpClientRequest.HttpClientRequest) => {
  const path = new URL(request.url).pathname;
  let body: unknown = DESCRIPTOR;
  let status = 200;
  if (path === "/oauth/mcp/register") {
    status = 201;
    body = {
      client_id: "fixture-client",
      client_name: "test",
      redirect_uris: ["http://127.0.0.1/goat-host-link"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  } else if (path === "/oauth/mcp/decision") {
    if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON decision body");
    const decision = decodeDecision(new TextDecoder().decode(request.body.body));
    body = {
      redirectTo: `http://127.0.0.1/goat-host-link?state=${encodeURIComponent(decision.authorization.state)}&code=fixture-code`,
    };
  } else if (path === "/oauth/mcp/token") {
    body = { access_token: "fixture-token", token_type: "Bearer", expires_in: 3600, scope: "" };
  } else if (path !== GOAT_ENVIRONMENT_PATH) {
    throw new Error(`Unexpected exchange path: ${path}`);
  }
  return Object.defineProperty(
    HttpClientResponse.fromWeb(request, Response.json(body, { status })),
    "json",
    { configurable: true, value: Effect.succeed(body) },
  );
};

const clientFixture = (client: HttpClient.HttpClient, beforeWrite = Effect.void) => {
  let stored: Option.Option<Uint8Array> = Option.none();
  let writes = 0;
  return {
    writes: () => writes,
    layer: LinkedHosts.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.sync(() => stored),
          set: (_name, bytes) =>
            beforeWrite.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  stored = Option.some(bytes);
                  writes += 1;
                }),
              ),
            ),
        }),
      ),
      Layer.provide(NodeCrypto.layer),
    ),
  };
};

const expectUnavailable = <A>(exit: Exit.Exit<A, LinkedHosts.LinkedHostError>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(error)).toBe(true);
    if (Option.isSome(error)) expect(error.value).toMatchObject({ reason: "host_unavailable" });
  }
};

describe("LinkedHosts deadlines", () => {
  it.effect.each(STAGES)("times out a linked-host $name body without saving credentials", (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const requests: Array<string> = [];
      let heldSignal: AbortSignal | undefined;
      const fixture = clientFixture(
        HttpClient.make((request, _url, signal) => {
          const path = new URL(request.url).pathname;
          requests.push(path);
          const response = exchangeResponse(request);
          if (path === stage.path) {
            heldSignal = signal;
            Object.defineProperty(response, "json", {
              value: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
              ),
            });
          }
          return Effect.succeed(response);
        }),
      );
      yield* Effect.gen(function* () {
        const links = yield* LinkedHosts.LinkedHosts;
        const fiber = yield* links
          .link(LINK_INPUT)
          .pipe(
            Effect.exit,
            Effect.ensuring(Deferred.succeed(finished, undefined)),
            Effect.forkScoped,
          );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("21 seconds");
        expect(yield* Deferred.isDone(finished)).toBe(true);
        expect(yield* Deferred.isDone(cancelled)).toBe(true);
        expect(heldSignal?.aborted).toBe(true);
        expectUnavailable(yield* Fiber.join(fiber));
        expect(requests).toEqual(STAGES.slice(0, STAGES.indexOf(stage) + 1).map((s) => s.path));
        expect(fixture.writes()).toBe(0);
        expect(yield* links.list).toEqual([]);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("shares one deadline between linked-host headers and body", () =>
    Effect.gen(function* () {
      const headers = yield* Deferred.make<void>();
      const body = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const fixture = clientFixture(
        HttpClient.make((request) => {
          const response = exchangeResponse(request);
          const json = response.json;
          Object.defineProperty(response, "json", {
            value: Deferred.succeed(body, undefined).pipe(
              Effect.andThen(json.pipe(Effect.delay("12 seconds"))),
            ),
          });
          return Deferred.succeed(headers, undefined).pipe(
            Effect.andThen(Effect.succeed(response).pipe(Effect.delay("12 seconds"))),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const links = yield* LinkedHosts.LinkedHosts;
        const fiber = yield* links
          .link(LINK_INPUT)
          .pipe(
            Effect.exit,
            Effect.ensuring(Deferred.succeed(finished, undefined)),
            Effect.forkScoped,
          );
        yield* Deferred.await(headers);
        yield* TestClock.adjust("12 seconds");
        yield* Deferred.await(body);
        yield* TestClock.adjust("9 seconds");
        expect(yield* Deferred.isDone(finished)).toBe(true);
        expectUnavailable(yield* Fiber.join(fiber));
        expect(fixture.writes()).toBe(0);
        expect(yield* links.list).toEqual([]);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("bounds the whole linked-host exchange across individually timely bodies", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const finished = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const requests: Array<string> = [];
      const fixture = clientFixture(
        HttpClient.make((request) => {
          const path = new URL(request.url).pathname;
          requests.push(path);
          const response = exchangeResponse(request);
          const json = response.json;
          return Effect.succeed(
            Object.defineProperty(response, "json", {
              value: Queue.offer(started, path).pipe(
                Effect.andThen(json.pipe(Effect.delay("16 seconds"))),
                Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
              ),
            }),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const links = yield* LinkedHosts.LinkedHosts;
        const fiber = yield* links
          .link(LINK_INPUT)
          .pipe(
            Effect.exit,
            Effect.ensuring(Deferred.succeed(finished, undefined)),
            Effect.forkScoped,
          );
        for (const stage of STAGES.slice(0, 3)) {
          expect(yield* Queue.take(started)).toBe(stage.path);
          yield* TestClock.adjust("16 seconds");
        }
        expect(yield* Queue.take(started)).toBe("/oauth/mcp/token");
        yield* TestClock.adjust("13 seconds");
        expect(yield* Deferred.isDone(finished)).toBe(true);
        expect(yield* Deferred.isDone(cancelled)).toBe(true);
        expectUnavailable(yield* Fiber.join(fiber));
        expect(requests).toEqual(STAGES.map((stage) => stage.path));
        expect(fixture.writes()).toBe(0);
        expect(yield* links.list).toEqual([]);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a held token body without replacing an existing link or replaying OAuth", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const requests: Array<string> = [];
      let hold = false;
      const fixture = clientFixture(
        HttpClient.make((request) => {
          const path = new URL(request.url).pathname;
          requests.push(path);
          const response = exchangeResponse(request);
          if (hold && path === "/oauth/mcp/token") {
            Object.defineProperty(response, "json", {
              value: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
              ),
            });
          }
          return Effect.succeed(response);
        }),
      );
      yield* Effect.gen(function* () {
        const links = yield* LinkedHosts.LinkedHosts;
        yield* links.link(LINK_INPUT);
        const before = yield* links.find("box");
        hold = true;
        requests.length = 0;
        const fiber = yield* links
          .link({ ...LINK_INPUT, access: "full-access" })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(yield* Deferred.isDone(cancelled)).toBe(true);
        const exit = yield* Fiber.join(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(requests).toEqual(STAGES.map((stage) => stage.path));
        expect(fixture.writes()).toBe(1);
        expect(yield* links.find("box")).toEqual(before);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("does not apply the exchange deadline to the authority check or catalog save", () =>
    Effect.gen(function* () {
      const saving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writing = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const fixture = clientFixture(
        HttpClient.make((request) => Effect.succeed(exchangeResponse(request))),
        Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(commit))),
      );
      yield* Effect.gen(function* () {
        const links = yield* LinkedHosts.LinkedHosts;
        const fiber = yield* links
          .link({
            ...LINK_INPUT,
            beforeSave: Deferred.succeed(saving, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          })
          .pipe(Effect.ensuring(Deferred.succeed(finished, undefined)), Effect.forkScoped);
        yield* Deferred.await(saving);
        yield* TestClock.adjust("61 seconds");
        expect(yield* Deferred.isDone(finished)).toBe(false);
        expect(fixture.writes()).toBe(0);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(writing);
        yield* TestClock.adjust("61 seconds");
        expect(yield* Deferred.isDone(finished)).toBe(false);
        expect(fixture.writes()).toBe(0);
        yield* Deferred.succeed(commit, undefined);
        expect(yield* Fiber.join(fiber)).toMatchObject({ replaced: false, host: { name: "box" } });
        expect(fixture.writes()).toBe(1);
        expect(yield* links.list).toHaveLength(1);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "an older peer without OAuth registration",
      path: "/oauth/mcp/register",
      status: 404,
      body: {},
      reason: "host_unavailable",
    },
    {
      name: "a malformed descriptor",
      path: GOAT_ENVIRONMENT_PATH,
      status: 200,
      body: {},
      reason: "host_unavailable",
    },
    {
      name: "invalid descriptor JSON",
      path: GOAT_ENVIRONMENT_PATH,
      status: 200,
      body: {},
      rawBody: "invalid JSON",
      reason: "host_unavailable",
    },
    {
      name: "a malformed registration",
      path: "/oauth/mcp/register",
      status: 201,
      body: {},
      reason: "host_unavailable",
    },
    {
      name: "a denied pairing decision",
      path: "/oauth/mcp/decision",
      status: 403,
      body: { error: "access_denied" },
      reason: "link_refused",
    },
    {
      name: "a malformed approval",
      path: "/oauth/mcp/decision",
      status: 200,
      body: {},
      reason: "host_unavailable",
    },
    {
      name: "an approval with mismatched state",
      path: "/oauth/mcp/decision",
      status: 200,
      body: { redirectTo: "http://127.0.0.1/goat-host-link?state=wrong&code=fixture-code" },
      reason: "link_refused",
    },
    {
      name: "an approval to another origin",
      path: "/oauth/mcp/decision",
      status: 200,
      body: {},
      redirectOrigin: "https://other.example",
      reason: "link_refused",
    },
    {
      name: "a refused token request",
      path: "/oauth/mcp/token",
      status: 400,
      body: { error: "invalid_grant" },
      reason: "link_refused",
    },
    {
      name: "a malformed token",
      path: "/oauth/mcp/token",
      status: 200,
      body: {},
      reason: "host_unavailable",
    },
  ])("saves no credentials for $name", (scenario) =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const fixture = clientFixture(
        HttpClient.make((request) => {
          const path = new URL(request.url).pathname;
          requests.push(path);
          let body: unknown = scenario.body;
          if (path === scenario.path && "redirectOrigin" in scenario) {
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected a JSON decision body");
            const decision = decodeDecision(new TextDecoder().decode(request.body.body));
            body = {
              redirectTo: `${scenario.redirectOrigin}/goat-host-link?state=${encodeURIComponent(decision.authorization.state)}&code=fixture-code`,
            };
          }
          return Effect.succeed(
            path === scenario.path
              ? HttpClientResponse.fromWeb(
                  request,
                  "rawBody" in scenario
                    ? new Response(scenario.rawBody, { status: scenario.status })
                    : Response.json(body, { status: scenario.status }),
                )
              : exchangeResponse(request),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const links = yield* LinkedHosts.LinkedHosts;
        const error = yield* links.link(LINK_INPUT).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: scenario.reason });
        if (scenario.status === 404) expect(error.message).toContain("update it");
        expect(requests).toEqual(
          STAGES.slice(0, STAGES.findIndex((stage) => stage.path === scenario.path) + 1).map(
            (stage) => stage.path,
          ),
        );
        expect(fixture.writes()).toBe(0);
        expect(yield* links.list).toEqual([]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});

describe("LinkedHosts", () => {
  it.live("links with a pairing URL to a session the host accepts at the chosen access", () =>
    Effect.gen(function* () {
      const { result, requests } = yield* withHost((hostAuth) =>
        Effect.gen(function* () {
          const links = yield* LinkedHosts.LinkedHosts;
          const code = yield* pairingCode(hostAuth);
          const linked = yield* links.link({
            name: "build-box",
            url: `https://${HOST}/pair#token=${code}`,
            access: "approval-required",
            clientName: "GOAT on laptop",
            beforeSave: Effect.void,
          });
          const found = yield* links.find("build-box");
          const token = Option.getOrThrow(found).token;
          const session = yield* hostAuth.authenticateMcpClient(
            HttpServerRequest.fromWeb(
              new Request(`http://127.0.0.1/mcp`, {
                headers: { host: HOST, authorization: `Bearer ${token}` },
              }),
            ),
          );
          return { linked, listed: yield* links.list, session, names: yield* links.names };
        }),
      );
      expect(result.linked).toMatchObject({
        replaced: false,
        host: {
          name: "build-box",
          baseUrl: `https://${HOST}`,
          environmentId: "env-box",
          label: "Build box",
          access: "approval-required",
        },
      });
      expect(Date.parse(result.linked.host.expiresAt)).toBeGreaterThan(
        Date.parse(result.linked.host.linkedAt),
      );
      // Tools see the link, never its token.
      expect(JSON.stringify(result.listed)).not.toContain("token");
      expect(result.names).toEqual(["build-box"]);
      expect(result.session).toMatchObject({
        label: "GOAT on laptop",
        access: "approval-required",
        approvals: false,
      });
      expect(requests).toEqual([
        `GET ${GOAT_ENVIRONMENT_PATH}`,
        "POST /oauth/mcp/register",
        "POST /oauth/mcp/decision",
        "POST /oauth/mcp/token",
      ]);
    }),
  );

  it.live("refuses a spent code and saves nothing", () =>
    Effect.gen(function* () {
      const { result } = yield* withHost((hostAuth) =>
        Effect.gen(function* () {
          const links = yield* LinkedHosts.LinkedHosts;
          const code = yield* pairingCode(hostAuth);
          yield* links.link({
            name: "first",
            url: `https://${HOST}`,
            code,
            access: "read-only",
            clientName: "GOAT",
            beforeSave: Effect.void,
          });
          const again = yield* links
            .link({
              name: "second",
              url: `https://${HOST}`,
              code,
              access: "read-only",
              clientName: "GOAT",
              beforeSave: Effect.void,
            })
            .pipe(Effect.flip);
          return { again, names: yield* links.names };
        }),
      );
      expect(result.again).toMatchObject({ reason: "link_refused" });
      expect(result.names).toEqual(["first"]);
    }),
  );

  it.live("saves nothing when the caller loses its authority during the exchange", () =>
    Effect.gen(function* () {
      const { result } = yield* withHost((hostAuth) =>
        Effect.gen(function* () {
          const links = yield* LinkedHosts.LinkedHosts;
          const code = yield* pairingCode(hostAuth);
          const refused = yield* links
            .link({
              name: "box",
              url: `https://${HOST}`,
              code,
              access: "full-access",
              clientName: "GOAT",
              beforeSave: Effect.fail("caller_changed" as const),
            })
            .pipe(Effect.flip);
          return { refused, names: yield* links.names };
        }),
      );
      expect(result.refused).toBe("caller_changed");
      expect(result.names).toEqual([]);
    }),
  );

  it.live("preserves a same-name link and its token when the exchanged descriptor is refused", () =>
    Effect.gen(function* () {
      const { result } = yield* withHost((hostAuth) =>
        Effect.gen(function* () {
          const links = yield* LinkedHosts.LinkedHosts;
          const input = {
            name: "box",
            url: `https://${HOST}`,
            access: "read-only" as const,
            clientName: "GOAT",
            beforeSave: Effect.void,
          };
          yield* links.link({ ...input, code: yield* pairingCode(hostAuth) });
          const before = Option.getOrThrow(yield* links.find("box"));
          const refused = yield* links
            .link({
              ...input,
              access: "full-access",
              code: yield* pairingCode(hostAuth),
              acceptDescriptor: (descriptor) => {
                expect(descriptor).toEqual(DESCRIPTOR);
                return Effect.fail("self_link" as const);
              },
            })
            .pipe(Effect.flip);
          return { refused, before, after: Option.getOrThrow(yield* links.find("box")) };
        }),
      );
      expect(result.refused).toBe("self_link");
      expect(result.after).toEqual(result.before);
    }),
  );

  it.live("keeps a label the caller chose over the host's own", () =>
    Effect.gen(function* () {
      const { result } = yield* withHost((hostAuth) =>
        Effect.gen(function* () {
          const links = yield* LinkedHosts.LinkedHosts;
          yield* links.link({
            name: "box",
            url: `https://${HOST}`,
            code: yield* pairingCode(hostAuth),
            access: "read-only",
            clientName: "GOAT",
            label: "Mac Studio",
            beforeSave: Effect.void,
          });
          return (yield* links.list).find((host) => host.name === "box")?.label;
        }),
      );
      expect(result).toBe("Mac Studio");
    }),
  );

  it.live("replaces a link by name and forgets it on unlink", () =>
    Effect.gen(function* () {
      const { result } = yield* withHost((hostAuth) =>
        Effect.gen(function* () {
          const links = yield* LinkedHosts.LinkedHosts;
          const link = (access: "read-only" | "full-access") =>
            pairingCode(hostAuth).pipe(
              Effect.flatMap((code) =>
                links.link({
                  name: "box",
                  url: `https://${HOST}`,
                  code,
                  access,
                  clientName: "GOAT",
                  beforeSave: Effect.void,
                }),
              ),
            );
          yield* link("read-only");
          const replaced = yield* link("full-access");
          const listed = yield* links.list;
          const removed = yield* links.unlink("box");
          return { replaced, listed, removed, after: yield* links.find("box") };
        }),
      );
      expect(result.replaced).toMatchObject({ replaced: true, host: { access: "full-access" } });
      expect(result.listed).toHaveLength(1);
      expect(Option.isSome(result.removed)).toBe(true);
      expect(Option.isNone(result.after)).toBe(true);
    }),
  );
});

describe("parseLinkTarget", () => {
  it("reads the code from a pairing URL and keeps only the origin", () => {
    expect(LinkedHosts.parseLinkTarget("https://box.ts.net/pair#token=abc", undefined)).toEqual({
      baseUrl: "https://box.ts.net",
      code: "abc",
    });
    expect(LinkedHosts.parseLinkTarget("http://10.0.0.5:3773/", "  xyz ")).toEqual({
      baseUrl: "http://10.0.0.5:3773",
      code: "xyz",
    });
  });

  it("refuses addresses it cannot link", () => {
    expect(LinkedHosts.parseLinkTarget("https://box.ts.net", undefined)).toContain("pairing URL");
    expect(LinkedHosts.parseLinkTarget("https://box.ts.net/app#token=a", undefined)).toContain(
      "origin",
    );
    expect(LinkedHosts.parseLinkTarget("ssh://box", "a")).toContain("not supported");
    expect(LinkedHosts.parseLinkTarget("https://u:p@box", "a")).toContain("credentials");
  });
});

describe("linkWriteRefusal", () => {
  it("lets a caller write only when its ceiling covers the link's access", () => {
    const link = (access: LinkedHosts.LinkedHost["access"]) => ({ name: "box", access });
    expect(LinkedHosts.linkWriteRefusal(link("approval-required"), "approval-required")).toBe(null);
    expect(LinkedHosts.linkWriteRefusal(link("auto"), "full-access")).toBe(null);
    expect(LinkedHosts.linkWriteRefusal(link("full-access"), "auto")).toContain("more than");
    expect(LinkedHosts.linkWriteRefusal(link("read-only"), "full-access")).toContain("read-only");
  });
});
