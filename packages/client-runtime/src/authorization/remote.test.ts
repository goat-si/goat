import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentAuthInvalidError } from "@goat/contracts";
import { hashTelemetryId } from "@goat/shared/telemetryId";
import {
  bootstrapRemoteBearerSession,
  exchangeRemoteDpopAccessToken,
  issueRemoteDpopWebSocketTicket,
  issueRemoteWebSocketTicket,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: Array<FetchCall> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    if (!response) {
      return Promise.reject(new Error("Unexpected fetch call"));
    }
    return Promise.resolve(response);
  }) satisfies typeof fetch;

  return { fetchFn, calls };
};

const provideRemoteHttp = (fetchFn: typeof fetch) =>
  Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn));

const expectFetchCall = (
  calls: ReadonlyArray<FetchCall>,
  index: number,
  expected: {
    readonly url: string;
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): void => {
  const call = calls[index - 1];
  expect(call).toBeDefined();
  if (!call) {
    return;
  }

  const [url, init] = call;
  expect(String(url)).toBe(expected.url);
  expect(init).toEqual(
    expect.objectContaining({
      method: expected.method,
    }),
  );
  expect(init.headers).toEqual(expect.objectContaining(expected.headers ?? {}));

  if ("body" in expected) {
    const body = init.body;
    if (typeof body === "string") {
      expect(body).toBe(expected.body);
    } else if (body instanceof Uint8Array) {
      expect(new TextDecoder().decode(body)).toBe(expected.body);
    } else {
      throw new Error("Expected fetch request body");
    }
  }
};

describe("remote environment authorization", () => {
  it.effect("exchanges managed credentials and admits websocket requests with DPoP", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({
          access_token: "dpop-access-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 3600,
          scope: "orchestration:read orchestration:operate terminal:operate review:write",
        }),
        Response.json({
          ticket: "ws-ticket",
          expiresAt: "2026-05-01T12:05:00.000Z",
        }),
      );

      const token = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: "https://remote.example.com/",
        credential: "one-time-credential",
        dpopProof: "token-proof",
        clientMetadata: {
          label: "T3 Code Mobile",
          deviceType: "mobile",
          os: "iOS",
        },
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      yield* issueRemoteDpopWebSocketTicket({
        httpBaseUrl: "https://remote.example.com/",
        accessToken: token.access_token,
        dpopProof: "resource-proof",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/oauth/token",
        method: "POST",
        headers: { dpop: "token-proof", "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=one-time-credential&subject_token_type=urn%3Agoat%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&client_label=T3+Code+Mobile&client_device_type=mobile&client_os=iOS",
      });
      expectFetchCall(fetch.calls, 2, {
        url: "https://remote.example.com/api/auth/websocket-ticket",
        method: "POST",
        headers: {
          authorization: "DPoP dpop-access-token",
          dpop: "resource-proof",
        },
      });
    }),
  );

  it.effect("allows a client to explicitly narrow a pairing grant", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            access_token: "read-only-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "orchestration:read",
          },
          { status: 200 },
        ),
      );

      yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://remote.example.com/",
        credential: "pairing-token",
        scopes: ["orchestration:read"],
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/oauth/token",
        method: "POST",
        body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=pairing-token&subject_token_type=urn%3Agoat%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&scope=orchestration%3Aread",
      });
    }),
  );

  it.effect("revives declared typed errors from remote auth failures", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "missing_credential",
            traceId: "trace-auth-test",
          },
          { status: 401 },
        ),
      );

      const error = yield* issueRemoteWebSocketTicket({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "expired-token",
      }).pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip);

      expect(isEnvironmentAuthInvalidError(error)).toBe(true);
      if (isEnvironmentAuthInvalidError(error)) {
        expect(error.reason).toBe("missing_credential");
        expect(error.traceId).toBe("trace-auth-test");
      }
    }),
  );

  it.effect("mints a websocket url that targets the rpc route with a short-lived ticket", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json(
          {
            ticket: "ws-ticket",
            expiresAt: "2026-05-01T12:05:00.000Z",
          },
          { status: 200 },
        ),
      );

      const url = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: "wss://remote.example.com/",
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "bearer-token",
        clientMetadata: {
          surface: "mobile",
          appVersion: "1.2.3",
          deviceType: "mobile",
          os: "Android",
          osMajorVersion: 15,
          deviceModel: "Pixel 9",
        },
        connectionMethod: "relay",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(url).toBe(
        "wss://remote.example.com/ws?wsTicket=ws-ticket&clientSurface=mobile&clientAppVersion=1.2.3&clientDeviceType=phone&clientOs=Android&clientOsMajorVersion=15&clientDeviceModel=Pixel+9&connectionMethod=relay",
      );
    }),
  );

  it.effect("binds a DPoP client's rpc ticket to its key and proves the upgrade", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "ws-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      const proofs: Array<{ method: string; url: string; accessToken: string }> = [];

      const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: "wss://remote.example.com/",
        httpBaseUrl: "https://remote.example.com/",
        accessToken: "dpop-access-token",
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed(`proof-${proofs.length}`);
        },
        connectionMethod: "relay",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/api/auth/websocket-ticket/rpc",
        method: "POST",
        headers: { authorization: "DPoP dpop-access-token", dpop: "proof-1" },
      });
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://remote.example.com/api/auth/websocket-ticket/rpc",
          accessToken: "dpop-access-token",
        },
        { method: "GET", url: "https://remote.example.com/ws", accessToken: "ws-ticket" },
      ]);
      expect(url).toBe(
        "wss://remote.example.com/ws?wsTicket=ws-ticket&dpop=proof-2&connectionMethod=relay",
      );
    }),
  );

  it.effect("requests the audience route even without a fallback proof", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "media-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      yield* issueRemoteDpopWebSocketTicket({
        httpBaseUrl: "https://remote.example.com/",
        accessToken: "dpop-access-token",
        dpopProof: "media-proof",
        use: "media",
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      expectFetchCall(fetch.calls, 1, {
        url: "https://remote.example.com/api/auth/websocket-ticket/media",
        method: "POST",
        headers: { dpop: "media-proof" },
      });
    }),
  );

  it.effect("falls back to the bare ticket path on a server without the audience route", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ message: "Not Found" }, { status: 404 }),
        Response.json({ ticket: "old-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      const proofs: Array<{ method: string; url: string; accessToken: string }> = [];

      const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: "wss://remote.example.com/",
        httpBaseUrl: "https://remote.example.com/",
        accessToken: "dpop-access-token",
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed(`proof-${proofs.length}`);
        },
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(fetch.calls.map(([target]) => String(target))).toEqual([
        "https://remote.example.com/api/auth/websocket-ticket/rpc",
        "https://remote.example.com/api/auth/websocket-ticket",
      ]);
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://remote.example.com/api/auth/websocket-ticket/rpc",
          accessToken: "dpop-access-token",
        },
        {
          method: "POST",
          url: "https://remote.example.com/api/auth/websocket-ticket",
          accessToken: "dpop-access-token",
        },
        { method: "GET", url: "https://remote.example.com/ws", accessToken: "old-ticket" },
      ]);
      expectFetchCall(fetch.calls, 2, {
        url: "https://remote.example.com/api/auth/websocket-ticket",
        method: "POST",
        headers: { dpop: "proof-2" },
      });
      expect(new URL(url).searchParams.get("wsTicket")).toBe("old-ticket");
      expect(new URL(url).searchParams.get("dpop")).toBe("proof-3");
    }),
  );

  it.effect("names the signed-in Connect account and this device by hash only", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "ws-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );

      const url = new URL(
        yield* resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: "wss://remote.example.com/",
          httpBaseUrl: "https://remote.example.com/",
          bearerToken: "bearer-token",
        }).pipe(
          provideRemoteHttp(fetch.fetchFn),
          Effect.provideService(
            ClientCapabilities.CloudSession,
            ClientCapabilities.CloudSession.of({
              identity: Effect.succeedSome({ accountId: "user_connect" }),
              clerkToken: Effect.succeed("clerk-token"),
            }),
          ),
          Effect.provideService(ClientCapabilities.AnalyticsDevice, {
            id: Effect.succeedSome("device-1"),
          }),
        ),
      );

      expect(url.searchParams.get("clientOwner")).toBe(hashTelemetryId("user_connect"));
      expect(url.searchParams.get("clientDevice")).toBe(hashTelemetryId("device-1"));
      expect(url.toString()).not.toContain("user_connect");
      expect(url.toString()).not.toContain("device-1");
    }),
  );
});

describe.each(["bearer", "dpop"] as const)("%s bootstrap URN compatibility", (method) => {
  const exchange = () =>
    method === "dpop"
      ? exchangeRemoteDpopAccessToken({
          httpBaseUrl: "https://remote.example.com",
          credential: "bootstrap",
          dpopProof: "proof",
          scopes: ["orchestration:read"],
        })
      : bootstrapRemoteBearerSession({
          httpBaseUrl: "https://remote.example.com",
          credential: "bootstrap",
          scopes: ["orchestration:read"],
        });

  it.effect.each([false, true])(
    "retries a schema rejection once with the legacy URN, declared=%s",
    (declared) =>
      Effect.gen(function* () {
        const fetch = recordedFetch(
          declared
            ? Response.json(
                {
                  _tag: "EnvironmentRequestInvalidError",
                  code: "invalid_request",
                  reason: "invalid_scope",
                  traceId: "fixture",
                },
                { status: 400 },
              )
            : new Response("old schema", { status: 400 }),
          Response.json({
            access_token: "access",
            token_type: method === "dpop" ? "DPoP" : "Bearer",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            expires_in: 3600,
            scope: "orchestration:read",
          }),
        );
        const result = yield* exchange().pipe(provideRemoteHttp(fetch.fetchFn));
        expect(result.access_token).toBe("access");
        expect(fetch.calls).toHaveLength(2);
        const first = new URLSearchParams(String(fetch.calls[0]![1].body));
        const second = new URLSearchParams(String(fetch.calls[1]![1].body));
        expect(first.get("subject_token_type")).toBe(
          "urn:goat:params:oauth:token-type:environment-bootstrap",
        );
        expect(second.get("subject_token_type")).toBe(
          "urn:t3:params:oauth:token-type:environment-bootstrap",
        );
        first.set("subject_token_type", second.get("subject_token_type")!);
        expect(first.toString()).toBe(second.toString());
        expect(new Headers(fetch.calls[1]![1].headers).get("dpop")).toBe(
          method === "dpop" ? "proof" : null,
        );
      }),
  );

  it.effect("does not retry a second schema rejection", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        new Response(null, { status: 400 }),
        new Response(null, { status: 400 }),
      );
      const error = yield* exchange().pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip);
      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        status: 400,
      });
      expect(fetch.calls).toHaveLength(2);
    }),
  );

  it.effect.each([401, 403, 500])("does not retry HTTP %s", (status) =>
    Effect.gen(function* () {
      const fetch = recordedFetch(new Response(null, { status }));
      yield* exchange().pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip);
      expect(fetch.calls).toHaveLength(1);
    }),
  );
});

describe("descriptor path compatibility", () => {
  it.effect("falls back on HTTP 404 to an older server's descriptor", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        new Response(null, { status: 404 }),
        Response.json({
          environmentId: "old",
          label: "Old server",
          serverVersion: "0.0.1",
          platform: { os: "linux", arch: "x64" },
          capabilities: {},
        }),
      );
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com",
      }).pipe(provideRemoteHttp(fetch.fetchFn));
      expect(descriptor.environmentId).toBe("old");
      expect(fetch.calls.map(([url]) => String(url))).toEqual([
        "https://remote.example.com/.well-known/goat/environment",
        "https://remote.example.com/.well-known/t3/environment",
      ]);
    }),
  );
  it.effect.each([404, 403, 500])("bounds retries when endpoints return HTTP %s", (status) =>
    Effect.gen(function* () {
      const fetch = recordedFetch(new Response(null, { status }), new Response(null, { status }));
      const error = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com",
      }).pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip);
      expect(error).toMatchObject({ _tag: "RemoteEnvironmentAuthUndeclaredStatusError", status });
      expect(fetch.calls).toHaveLength(status === 404 ? 2 : 1);
    }),
  );
});
