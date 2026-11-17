import { describe, expect, it } from "@effect/vitest";
import { fakeSourceControlDriverInstance } from "@goat/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { sourceControlMediaResponse } from "./sourceControlMediaResponse.ts";

describe("sourceControlMediaResponse", () => {
  it.effect("passes on a host's refusal of a pull request image with no body", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const url = sourceControlDefinitions
      .find("github")
      ?.rawFileUrl?.({ repositoryUrl: "https://github.com/owner/private", sha, path: "a.png" });
    if (!url) throw new Error("GitHub serves no raw file URL");
    const media = sourceControlDefinitions.mediaUrl(url)!;
    const fetched: string[] = [];
    const layerDrivers = Layer.succeed(BuiltInDrivers.SourceControlDrivers, [
      {
        driver: { kind: media.definition.kind, definition: media.definition },
        instance: fakeSourceControlDriverInstance(media.definition.kind, {
          pullRequests: null,
          fetchMedia: (request) =>
            Effect.sync(() => {
              fetched.push(request.url);
              return HttpClientResponse.fromWeb(
                HttpClientRequest.get(request.url),
                new Response("denied page", {
                  status: 403,
                  headers: { "content-type": "text/html", "content-length": "11" },
                }),
              );
            }),
        }),
      },
    ]);
    const layerIdentities = Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    });
    return Effect.gen(function* () {
      const response = yield* sourceControlMediaResponse(
        { url: media.fetchUrl, cwd: "/repo", repository: "owner/private", expiresAt: 0 },
        {},
      );
      expect(fetched).toEqual([`https://raw.githubusercontent.com/owner/private/${sha}/a.png`]);
      expect(response.status).toBe(403);
      expect(response.headers["content-type"]).toBeUndefined();
      expect(response.headers["content-length"]).toBeUndefined();
    }).pipe(Effect.provide(Layer.mergeAll(layerDrivers, layerIdentities)), Effect.scoped);
  });

  it.effect(
    "media an older client sends with no repository, shown in a checkout with no repository identity, is fetched for no repository",
    () => {
      const url = "https://raw.githubusercontent.com/owner/private/main/a.png";
      const media = sourceControlDefinitions.mediaUrl(url)!;
      const requests: Array<{ readonly url: string; readonly repository?: string }> = [];
      const layerDrivers = Layer.succeed(BuiltInDrivers.SourceControlDrivers, [
        {
          driver: { kind: media.definition.kind, definition: media.definition },
          instance: fakeSourceControlDriverInstance(media.definition.kind, {
            pullRequests: null,
            fetchMedia: (request) =>
              Effect.sync(() => {
                requests.push(request);
                return HttpClientResponse.fromWeb(
                  HttpClientRequest.get(request.url),
                  new Response(null, { status: 404 }),
                );
              }),
          }),
        },
      ]);
      const layerIdentities = Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      });
      return Effect.gen(function* () {
        const response = yield* sourceControlMediaResponse(
          { url: media.fetchUrl, cwd: "/not-a-checkout", expiresAt: 0 },
          {},
        );
        expect(requests).toEqual([{ url, headers: {} }]);
        expect(response.status).toBe(404);
      }).pipe(Effect.provide(Layer.mergeAll(layerDrivers, layerIdentities)), Effect.scoped);
    },
  );
});
