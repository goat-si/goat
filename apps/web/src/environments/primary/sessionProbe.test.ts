import { it } from "@effect/vitest";
import { layerRemoteHttpClient, makeEnvironmentHttpApiClient } from "@goat/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { readPrimarySessionAnswer } from "./auth";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

const AUTH = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "goat_session",
};

/** This tab's own server, answering every request with `respond`. */
function primaryAnswering(respond: typeof fetch) {
  const requests: Array<Request> = [];
  const fetchFn: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    return respond(input, init);
  };
  const layer = Layer.effect(
    PrimaryEnvironmentHttpClient,
    makeEnvironmentHttpApiClient("http://primary.test/"),
  ).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));
  return { requests, layer };
}

const json = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

it.effect.each([
  [
    "the server says the session is gone",
    "revoked",
    json(200, { authenticated: false, auth: AUTH }),
  ],
  ["the session is signed in", "signed-in", json(200, { authenticated: true, auth: AUTH })],
  ["the request fails", "unknown", () => Promise.reject(new TypeError("Failed to fetch"))],
  ["the server fails (500)", "unknown", json(500, { message: "database unavailable" })],
  ["the server is unavailable (503)", "unknown", json(503, { message: "restarting" })],
  [
    "a proxy redirects to its sign-in page",
    "unknown",
    () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://login.test/" } }),
      ),
  ],
  [
    "a proxy answers with an HTML page",
    "unknown",
    () =>
      Promise.resolve(
        new Response("<html><body>Sign in</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
  ],
  ["the body has another shape", "unknown", json(200, { authenticated: "no", auth: AUTH })],
  ["the body leaves out authenticated", "unknown", json(200, { auth: AUTH })],
] as const)(
  "one auth/session read answers %s as %s, with a single GET and no retry",
  ([_case, answer, respond]) =>
    Effect.gen(function* () {
      const primary = primaryAnswering(respond);
      const result = yield* readPrimarySessionAnswer.pipe(Effect.provide(primary.layer));
      expect(result).toBe(answer);
      expect(
        primary.requests.map((request) => [request.method, new URL(request.url).pathname]),
      ).toEqual([["GET", "/api/auth/session"]]);
    }),
);

it.effect("a read that hears nothing for 10 s answers unknown and aborts its request", () =>
  Effect.gen(function* () {
    let aborted = false;
    const primary = primaryAnswering(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    );
    const read = yield* readPrimarySessionAnswer.pipe(
      Effect.provide(primary.layer),
      Effect.forkChild,
    );
    yield* TestClock.adjust("9999 millis");
    expect(aborted).toBe(false);
    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(read)).toBe("unknown");
    expect(aborted).toBe(true);
    expect(primary.requests).toHaveLength(1);
  }),
);
