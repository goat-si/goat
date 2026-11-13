import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
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

it.effect(
  "the remote client opens no span for a Pen route URL, whatever tracing the caller enabled, and keeps the capability out of errors and logs",
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
    const fetchFn: typeof globalThis.fetch = async (input) =>
      new Response("failed", { status: String(input).endsWith("/failure") ? 500 : 200 });
    return Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      yield* client.get(url);
      yield* client.get("https://example.com/traced");
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
      expect(spans.filter((span) => span.kind === "client")).toHaveLength(1);
    }).pipe(
      // Listed after the client on purpose: a caller's predicate must not re-enable the span.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => false),
      Effect.provide(
        Layer.merge(
          layerRemoteHttpClient(fetchFn),
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
