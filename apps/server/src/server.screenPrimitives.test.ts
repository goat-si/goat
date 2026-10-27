import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as LeaseRoute from "./cua/ComputerUseLeaseRoute.ts";
import * as Leases from "./cua/ComputerUseLeases.ts";
import * as Primitives from "./cua/ComputerUsePrimitiveChannel.ts";
import * as Environment from "./environment/ServerEnvironment.ts";
import * as Registry from "./mcp/McpSessionRegistry.ts";
import * as Server from "./server.ts";
import * as Settings from "./serverSettings.ts";

class Issuer extends Context.Service<Issuer, { readonly issue: Effect.Effect<void> }>()(
  "goat/server.screenPrimitives.test/Issuer",
) {}

const threadId = ThreadId.make("thread:runtime-channel");
const channelToken = "disposable-channel-token";

// The old runtime boundary exported no primitive channel to providers or requests.
const compose = Server.provideScreenPrimitives ?? (<A, E, R>(layer: Layer.Layer<A, E, R>) => layer);

it.effect(
  "provider-issued primitive authority reaches HTTP requests without accepting another token",
  () =>
    Effect.gen(function* () {
      const signals = yield* PubSub.unbounded<void>();
      const registry = yield* Registry.__testing.make().pipe(
        Effect.provideService(HttpServer.HttpServer, {
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: () => Effect.void,
        }),
        Effect.provideService(Environment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:test")),
          getDescriptor: Effect.die("unused"),
        }),
        Effect.provide(NodeServices.layer),
      );
      const credential = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("fixture"),
      });
      const issuer = Layer.effect(
        Issuer,
        Effect.gen(function* () {
          const channel = yield* Effect.serviceOption(Primitives.ComputerUsePrimitiveChannel);
          return {
            issue: Option.isNone(channel)
              ? Effect.void
              : channel.value.issue({
                  threadId,
                  attachmentGeneration: "attachment:fixture",
                  proxyChannelToken: channelToken,
                  expiresAt: 60_000,
                }),
          };
        }),
      );
      const runtime = compose(issuer).pipe(
        Layer.provideMerge(
          Layer.mock(Leases.ComputerUseLeases)({
            subscribe: PubSub.subscribe(signals),
            proxy: undefined,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        yield* (yield* Issuer).issue;
        const handler = yield* HttpRouter.toHttpEffect(LeaseRoute.layer);
        const request = (token: string) =>
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(
                  `http://goat.test/api/computer-use/lease?thread=${threadId}&primitive=1&instance=fixture`,
                  {
                    headers: {
                      authorization: credential.config.authorizationHeader,
                      "x-goat-proxy-channel": token,
                    },
                  },
                ),
              ),
            ),
          );
        assert.equal((yield* request("wrong-channel-token")).status, 401);
        const admitted = yield* request(channelToken);
        assert.equal(admitted.status, 200);
        assert.isNotEmpty(admitted.headers["x-goat-primitive-registration"]);
      }).pipe(
        Effect.provide(runtime),
        Effect.provideService(Registry.McpSessionRegistry, registry),
        Effect.provide(Settings.layerTest({ enableCua: true })),
      );
    }),
);
