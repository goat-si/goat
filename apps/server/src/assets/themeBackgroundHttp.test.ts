import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ServerHttp from "../http.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as AssetFixture from "./AssetAccess.testkit.ts";
import { issueThemeBackgroundUrl } from "./themeBackgroundAsset.ts";
import {
  publishedBackgroundBudget,
  PUBLISHED_BACKGROUND_MAX_BYTES,
} from "./publishedBackgroundBudget.ts";

it.live(
  "holds two full published background buffers until completion or abort and refuses a third",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-http-" });
        const configLayer = ServerConfig.layerTest(process.cwd(), base).pipe(
          Layer.provide(NodeServices.layer),
        );
        const secret = Layer.mock(SecretStore.ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
        });
        const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
        yield* fs.makeDirectory(path.dirname(config.environmentIdPath), { recursive: true });
        yield* fs.writeFileString(config.environmentIdPath, "http-env");
        yield* fs.makeDirectory(config.environmentThemesDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(config.environmentThemesDir, "nightfall.json"),
          JSON.stringify({
            name: "Nightfall",
            appearance: "dark",
            canvas: "#112233",
            accent: "#aabbcc",
          }),
        );
        const png = new Uint8Array(PUBLISHED_BACKGROUND_MAX_BYTES);
        png.set([137, 80, 78, 71, 13, 10, 26, 10]);
        yield* fs.writeFile(path.join(config.environmentThemesDir, "nightfall.png"), png);
        const themes = yield* EnvironmentTheme.readPublishedThemes(config.environmentThemesDir);
        const revision = themes[0]?.background;
        assert.isString(revision);
        const envLayer = EnvironmentTheme.layer.pipe(
          Layer.provide(configLayer),
          Layer.provide(NodeServices.layer),
        );
        const issued = yield* issueThemeBackgroundUrl("nightfall", revision!).pipe(
          Effect.provide(Layer.mergeAll(configLayer, secret, envLayer)),
        );
        assert.isNotNull(issued);
        const dependencies = Layer.mergeAll(
          AssetFixture.layerTest,
          configLayer,
          secret,
          envLayer,
          Layer.succeed(BuiltInDrivers.SourceControlDrivers, []),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
        );
        const services = yield* Layer.build(dependencies);
        const { handler, dispose } = HttpRouter.toWebHandler(ServerHttp.layerAssetRoute, {
          disableLogger: true,
        });
        const responses: Response[] = [];
        try {
          const url = `http://localhost${issued!.relativeUrl}`;
          const denied = yield* Effect.promise(() => handler(new Request(`${url}x`), services));
          responses.push(denied);
          assert.equal(denied.status, 404);
          assert.equal(denied.headers.get("cache-control"), "no-store");
          const first = yield* Effect.promise(() => handler(new Request(url), services));
          responses.push(first);
          const second = yield* Effect.promise(() => handler(new Request(url), services));
          responses.push(second);
          assert.equal(
            first.status,
            200,
            first.status === 200 ? "" : yield* Effect.promise(() => first.text()),
          );
          assert.equal(second.status, 200);
          assert.equal(
            publishedBackgroundBudget.inFlightBytes(),
            2 * PUBLISHED_BACKGROUND_MAX_BYTES,
          );
          const third = yield* Effect.promise(() => handler(new Request(url), services));
          responses.push(third);
          assert.equal(third.status, 503);
          assert.equal(third.headers.get("retry-after"), "1");
          assert.equal(third.headers.get("cache-control"), "no-store");
          yield* Effect.promise(() => first.body!.cancel());
          assert.equal(publishedBackgroundBudget.inFlightBytes(), PUBLISHED_BACKGROUND_MAX_BYTES);
          const head = yield* Effect.promise(() =>
            handler(new Request(url, { method: "HEAD" }), services),
          );
          responses.push(head);
          assert.equal(head.status, 200);
          assert.equal(head.headers.get("content-length"), String(PUBLISHED_BACKGROUND_MAX_BYTES));
          assert.equal(publishedBackgroundBudget.inFlightBytes(), PUBLISHED_BACKGROUND_MAX_BYTES);
          const fourth = yield* Effect.promise(() => handler(new Request(url), services));
          responses.push(fourth);
          assert.equal(fourth.status, 200);
          const replacement = new Uint8Array(png);
          replacement[8] = 42;
          yield* fs.writeFile(path.join(config.environmentThemesDir, "nightfall.png"), replacement);
          const verifiedBody = yield* Effect.promise(() => second.arrayBuffer());
          assert.equal(new Uint8Array(verifiedBody)[8], 0);
          yield* Effect.promise(() => fourth.body!.cancel());
          assert.equal(publishedBackgroundBudget.inFlightBytes(), 0);
        } finally {
          for (const response of responses) {
            if (response.body && !response.body.locked)
              yield* Effect.promise(() => response.body!.cancel());
          }
          yield* Effect.promise(dispose);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
