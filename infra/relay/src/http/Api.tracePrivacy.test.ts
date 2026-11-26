import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { traceRelayHttpRequestWith } from "./Api.ts";

describe("relay request tracing privacy", () => {
  it.effect("keeps the caller's address and user agent out of spans but not the route", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const seen: Array<{ remoteAddress: string | undefined; userAgent: string | undefined }> = [];
      const endpoint = Effect.gen(function* () {
        const routed = yield* HttpServerRequest.HttpServerRequest;
        seen.push({
          remoteAddress: Option.getOrUndefined(routed.remoteAddress),
          userAgent: routed.headers["user-agent"],
        });
        return HttpServerResponse.empty({ status: 204 });
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/mobile/devices", {
          method: "POST",
          headers: { "user-agent": "GOAT/2.3.0 iPhone" },
        }),
      ).modify({ remoteAddress: Option.some("203.0.113.9") });

      yield* traceRelayHttpRequestWith(endpoint, Layer.succeed(Tracer.Tracer, tracer)).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );

      expect(spans[0]?.attributes.get("client.address")).toBeUndefined();
      expect(spans[0]?.attributes.get("user_agent.original")).toBeUndefined();
      expect(seen).toEqual([{ remoteAddress: "203.0.113.9", userAgent: "GOAT/2.3.0 iPhone" }]);
    }),
  );
});
