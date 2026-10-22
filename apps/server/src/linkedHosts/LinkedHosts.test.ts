import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, EnvironmentHttpApi } from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
