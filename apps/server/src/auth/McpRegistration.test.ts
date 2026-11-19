import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { EnvironmentHttpApi } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as McpOAuthHttp from "./mcpOAuthHttp.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

class Api extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.mcpOAuth) {}
const config = ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-register-" });
const auth = EnvironmentAuth.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(config),
);
const routes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
  Layer.provideMerge(auth),
  Layer.provide(config),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect("returns an OAuth JSON error for malformed registration metadata", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    (web) =>
      Effect.promise(async () => {
        for (const body of [
          '{"client_name":42,"redirect_uris":["http://localhost/callback"]}',
          '{"redirect_uris":"http://localhost/callback"}',
        ]) {
          const response = await web.handler(
            new Request("http://localhost/oauth/mcp/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }),
          );
          expect(response.status).toBe(400);
          expect(response.headers.get("content-type")).toMatch(/^application\/json/);
          expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
        }
      }),
    (web) => Effect.promise(() => web.dispose()),
  ).pipe(Effect.provide(NodeServices.layer)),
);
