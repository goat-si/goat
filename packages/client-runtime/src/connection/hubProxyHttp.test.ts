import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { requestHubProxyJson } from "./hubProxyHttp.ts";

it.effect.each([null, { _tag: "Bearer" as const, token: "paired" }])(
  "proxy JSON preserves a paired/cookie hub prefix with %j",
  (authorization) =>
    Effect.gen(function* () {
      const calls: Array<{
        url: string;
        credentials?: RequestCredentials;
        authorization: string | null;
      }> = [];
      const fetchFn: typeof fetch = async (url, init) => {
        calls.push({
          url: String(url),
          ...(init?.credentials === undefined ? {} : { credentials: init.credentials }),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ ok: true });
      };
      yield* requestHubProxyJson(
        { httpBaseUrl: "https://hub.test/base/", authorization },
        "node",
        "/snapshot",
        (value) => Effect.succeed(value),
      ).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));
      expect(calls).toEqual([
        {
          url: "https://hub.test/base/hub/nodes/node/snapshot",
          authorization: authorization === null ? null : "Bearer paired",
          ...(authorization === null ? { credentials: "include" } : {}),
        },
      ]);
    }),
);
