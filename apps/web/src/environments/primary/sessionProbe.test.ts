import { it } from "@effect/vitest";
import { layerRemoteHttpClient } from "@goat/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { expect } from "vite-plus/test";

import { makePrimaryEnvironmentAuth } from "./sessionEnded";

const AUTH = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "goat_session",
};
const ORIGIN = "http://primary.test";

/** This page at ORIGIN, signed in by cookie unless told otherwise, whose server answers with `respond`. */
function pageAnswering(respond: typeof fetch, signedInByCookie = true) {
  const requests: Array<Request> = [];
  const inits: Array<RequestInit | undefined> = [];
  const fetchFn: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    inits.push(init);
    return respond(input, init);
  };
  const auth = makePrimaryEnvironmentAuth({
    page: () => ({ origin: ORIGIN, signedInByCookie }),
    httpLayer: Layer.merge(
      layerRemoteHttpClient(fetchFn),
      Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
    ),
  });
  return { requests, inits, sessionEnded: auth.sessionEnded };
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
    "the server says this browser is not signed in",
    true,
    json(200, { authenticated: false, auth: AUTH }),
  ],
  ["the session is signed in", false, json(200, { authenticated: true, auth: AUTH })],
  [
    "a failed request, which is also how fetch reports a refused redirect",
    false,
    () => Promise.reject(new TypeError("Failed to fetch")),
  ],
  ["the server fails (500)", false, json(500, { message: "database unavailable" })],
  ["the server is unavailable (503)", false, json(503, { message: "restarting" })],
  ["the server refuses the request (401)", false, json(401, { message: "unauthorized" })],
  ["the server forbids the request (403)", false, json(403, { message: "forbidden" })],
  [
    "a 3xx response that reaches the client unfollowed",
    false,
    () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://login.test/" } }),
      ),
  ],
  [
    "a proxy answers with an HTML page",
    false,
    () =>
      Promise.resolve(
        new Response("<html><body>Sign in</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
  ],
  ["the body has another shape", false, json(200, { authenticated: "no", auth: AUTH })],
  ["the body leaves out authenticated", false, json(200, { auth: AUTH })],
] as const)(
  "the session read answers ended only for a decoded 'not signed in': %s gives %s, with one GET of auth/session at this page's origin (#3473, contract)",
  ([_case, ended, respond]) =>
    Effect.gen(function* () {
      const page = pageAnswering(respond);
      expect(yield* page.sessionEnded(`${ORIGIN}/`)).toBe(ended);
      expect(page.requests.map((request) => [request.method, new URL(request.url).href])).toEqual([
        ["GET", `${ORIGIN}/api/auth/session`],
      ]);
    }),
);

it.effect.each([
  ["another origin", "http://elsewhere.test/", true],
  ["a base URL that does not parse", "not a url", true],
  ["a tab not signed in by cookie", `${ORIGIN}/`, false],
] as const)(
  "%s answers not ended and sends no request (#3473, guard)",
  ([_case, httpBaseUrl, signedInByCookie]) =>
    Effect.gen(function* () {
      const page = pageAnswering(json(200, { authenticated: false, auth: AUTH }), signedInByCookie);
      expect(yield* page.sessionEnded(httpBaseUrl)).toBe(false);
      expect(page.requests).toEqual([]);
    }),
);

it.effect(
  "the read refuses redirects, so a proxy's or another server's answer is never read, and keeps the page's other fetch options",
  () =>
    Effect.gen(function* () {
      const page = pageAnswering(json(200, { authenticated: true, auth: AUTH }));
      yield* page.sessionEnded(`${ORIGIN}/`);
      expect(page.inits.map((init) => [init?.redirect, init?.credentials])).toEqual([
        ["error", "include"],
      ]);
    }),
);

it.effect("interrupting the read aborts its request (#3473, bound)", () =>
  Effect.gen(function* () {
    let markRequested = () => {};
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    let aborted = false;
    const page = pageAnswering(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          markRequested();
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    );
    const read = yield* page.sessionEnded(`${ORIGIN}/`).pipe(Effect.forkChild);
    yield* Effect.promise(() => requested);
    expect(aborted).toBe(false);
    yield* Fiber.interrupt(read);
    expect(aborted).toBe(true);
    expect(page.requests).toHaveLength(1);
  }),
);
