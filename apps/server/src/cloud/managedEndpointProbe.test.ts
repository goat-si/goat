import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { probePublicEndpoint, nextProbeFailures } from "./managedEndpointProbe.ts";

it.effect("only a public descriptor with this environment identity counts as reachable", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const client = HttpClient.make((request) => {
      paths.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId: request.url.includes("healthy") ? "env-fixture" : "another-env",
          }),
        ),
      );
    });
    const run = (hostname: string) =>
      probePublicEndpoint({ hostname, environmentId: "env-fixture" }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      );
    expect(yield* run("healthy.example.test")).toBe(true);
    expect(yield* run("wrong.example.test")).toBe(false);
    expect(paths).toEqual([
      "https://healthy.example.test/.well-known/t3/environment",
      "https://wrong.example.test/.well-known/t3/environment",
    ]);
    expect(nextProbeFailures(0, false)).toBe(1);
    expect(nextProbeFailures(1, true)).toBe(0);
    expect(nextProbeFailures(0, true)).toBe(0);
    expect(nextProbeFailures(1, false)).toBe(2);
  }),
);
