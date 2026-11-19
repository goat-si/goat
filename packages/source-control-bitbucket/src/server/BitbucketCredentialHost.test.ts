import { ServerSettingsError } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as BitbucketApi from "./BitbucketApi.ts";

it.effect("uses the operator configured API host when resolving a saved credential", () => {
  const seen: Array<string | undefined> = [];
  const layer = BitbucketApi.layer.pipe(
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ username: "user" }))),
        ),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { GOAT_BITBUCKET_API_BASE_URL: "https://api.internal/2.0" },
        }),
      ),
    ),
    Layer.provideMerge(
      TestSourceControlHost.layer({
        resolveSettings: (settings, _kind, host) => {
          seen.push(host);
          return Effect.succeed(settings);
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    yield* (yield* BitbucketApi.BitbucketApi).probeAuth;
    assert.deepEqual(seen, ["api.internal"]);
  }).pipe(Effect.provide(layer));
});

it("keeps a safe credential-destination refusal visible", () => {
  const cause = new ServerSettingsError({
    settingsPath: "settings",
    operation: "normalize",
    reason:
      "Could not resolve source control credential: saved bitbucket credentials are only used for api.bitbucket.org (requested other.example).",
  });
  const error = new BitbucketApi.BitbucketRequestError({ operation: "request", cause });
  assert.include(error.detail, "saved bitbucket credentials are only used for api.bitbucket.org");
});
