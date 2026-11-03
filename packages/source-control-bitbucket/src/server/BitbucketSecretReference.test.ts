import { ServerSettingsError } from "@goat/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as BitbucketApi from "./BitbucketApi.ts";

it.effect("uses resolved Bitbucket credentials and refuses fallback when resolution fails", () => {
  let fail = false;
  const execute = vi.fn((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ username: "user" }))),
  );
  const layer = BitbucketApi.layer.pipe(
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            GOAT_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
            GOAT_BITBUCKET_ACCESS_TOKEN: "fallback",
          },
        }),
      ),
    ),
    Layer.provide(
      TestSourceControlHost.layer({
        resolveSettings: (settings, kind) =>
          fail
            ? Effect.fail(
                new ServerSettingsError({ settingsPath: "fixture", operation: "read-secret" }),
              )
            : Effect.succeed({
                ...settings,
                sourceControlHosts: {
                  ...settings.sourceControlHosts,
                  [kind]: { accessToken: "resolved-token" },
                },
              }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.probeAuth;
    assert.strictEqual(
      execute.mock.calls.at(-1)?.[0].headers.authorization,
      "Bearer resolved-token",
    );
    const count = execute.mock.calls.length;
    fail = true;
    assert.strictEqual((yield* bitbucket.probeAuth).status, "unknown");
    assert.strictEqual(execute.mock.calls.length, count);
  }).pipe(Effect.provide(layer));
});
