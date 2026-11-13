import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  executeEnvironmentHttpRequest,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "./http.ts";

describe("Pen route HTTP errors", () => {
  it.effect("redacts capability URLs from errors and their causes", () => {
    const capability = "a".repeat(43);
    const url = `http://127.0.0.1/pen-route/${capability}/api`;
    return Effect.gen(function* () {
      const error = yield* executeEnvironmentHttpRequest(
        url,
        1000,
        Effect.fail(`failed ${url}`),
      ).pipe(Effect.flip);
      expect(JSON.stringify(error)).not.toContain(capability);
      expect(String(error)).not.toContain(capability);
      expect(JSON.stringify(new RemoteEnvironmentAuthTimeoutError(url, 1))).not.toContain(
        capability,
      );
      expect(
        JSON.stringify(new RemoteEnvironmentAuthUndeclaredStatusError(url, 500)),
      ).not.toContain(capability);
    });
  });
});

import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpObservability from "@goat/shared/httpObservability";

it.effect(
  "keeps a capability out of spans, error messages and log annotations for successful and failing requests",
  () => {
    const capability = "b".repeat(43);
    const url = `http://127.0.0.1/pen-route/${capability}/api`;
    const spans: Tracer.NativeSpan[] = [];
    const logs: unknown[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("failed", { status: request.url.endsWith("/failure") ? 500 : 200 }),
        ),
      ),
    ).pipe(HttpClient.filterStatusOk);
    return Effect.gen(function* () {
      yield* client.get(url);
      const failureUrl = `${url}/failure`;
      const error = yield* executeEnvironmentHttpRequest(
        failureUrl,
        1000,
        client.get(failureUrl),
      ).pipe(Effect.flip);
      expect(String(error)).not.toContain(capability);
      yield* Effect.logWarning("request failed", { error });
      expect(JSON.stringify(logs)).not.toContain(capability);
      expect(JSON.stringify(spans.map((span) => [...span.attributes]))).not.toContain(capability);
      expect(spans.filter((span) => span.kind === "client")).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.merge(
          HttpObservability.layer,
          Logger.layer(
            [
              Logger.make((entry) => {
                logs.push(entry);
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      ),
      Effect.withTracer(tracer),
    );
  },
);
