import { vi } from "vite-plus/test";
vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
import { EnvironmentId } from "@goat/contracts";
import { RelayEnvironmentConnectScope, RelayEnvironmentStatusScope } from "@goat/contracts/relay";
import { RelayClientTracer, nonInterferingTracer } from "@goat/shared/relayTracing";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as ManagedRelay from "./managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";

it.effect(
  "does not export environment identifiers from real relay status, connect or authorization spans",
  () => {
    const sentinel = "sentinel-private-environment";
    const spans: Tracer.NativeSpan[] = [];
    const local: Tracer.NativeSpan[] = [];
    const collector = (out: Tracer.NativeSpan[]) =>
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          out.push(span);
          return span;
        },
      });
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const clerkToken = `${encode({ alg: "none" })}.${encode({ sub: "user" })}.signature`;
    const calls: string[] = [];
    const fetchFn: typeof globalThis.fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return Promise.resolve(
        url.endsWith("/v1/client/dpop-token")
          ? Response.json({
              access_token: "token",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "DPoP",
              expires_in: 1800,
              scope: `${RelayEnvironmentStatusScope} ${RelayEnvironmentConnectScope}`,
            })
          : Response.json(
              {
                _tag: "RelayAccountAccessDeniedError",
                code: "account_access_denied",
                reason: "suspended",
                traceId: "fixture",
              },
              { status: 403 },
            ),
      );
    };
    const signer = Layer.succeed(
      ManagedRelay.ManagedRelayDpopSigner,
      ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("thumbprint"),
        createProof: () => Effect.succeed("proof"),
      }),
    );
    const layer = ManagedRelay.layer({
      relayUrl: "https://relay.example.test",
      clientId: "goat-mobile",
    }).pipe(Layer.provide(signer), Layer.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));
    return Effect.gen(function* () {
      const relay = yield* ManagedRelay.ManagedRelayClient;
      const input = {
        clerkToken,
        environmentId: EnvironmentId.make(sentinel),
        scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
      };
      yield* relay.getEnvironmentStatus(input).pipe(Effect.exit);
      yield* relay.connectEnvironment(input).pipe(Effect.exit);
      yield* Effect.annotateCurrentSpan("environment.id", sentinel);
    }).pipe(
      Effect.withSpan("local.diagnostic"),
      Effect.provide(layer),
      Effect.provideService(RelayClientTracer, Option.some(nonInterferingTracer(collector(spans)))),
      Effect.withTracer(collector(local)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls.some((url) => url.includes(`/${sentinel}/status`))).toBe(true);
          expect(calls.some((url) => url.includes(`/${sentinel}/connect`))).toBe(true);
          expect(
            spans.some((span) => span.name === "clientRuntime.managedRelay.getEnvironmentStatus"),
          ).toBe(true);
          expect(
            spans.some((span) => span.name === "clientRuntime.managedRelay.connectEnvironment"),
          ).toBe(true);
          expect(spans.some((span) => span.name === "clientRuntime.managedRelay.authorize")).toBe(
            true,
          );
          expect(
            spans.map((span) => `${span.name} ${JSON.stringify([...span.attributes])}`).join("\n"),
          ).not.toContain(sentinel);
          expect(local.some((span) => span.attributes.get("environment.id") === sentinel)).toBe(
            true,
          );
        }),
      ),
    );
  },
);
