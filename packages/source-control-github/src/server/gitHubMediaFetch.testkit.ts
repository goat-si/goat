import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubRest from "./GitHubRest.ts";

/** The real media fetcher, signed in to github.com as `token`, sending through `httpClient`. */
export const makeSignedInMediaFetch = (token: string, httpClient: HttpClient.HttpClient) =>
  GitHubMediaFetch.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubRest.GitHubRest)({}),
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host) =>
            Effect.succeed({
              host,
              token: Redacted.make(token),
              source: "gh" as const,
              fingerprint: token,
            }),
        }),
        Layer.succeed(HttpClient.HttpClient, httpClient),
      ),
    ),
  );
