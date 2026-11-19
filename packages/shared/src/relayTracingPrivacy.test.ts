import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";
import { nonInterferingTracer } from "./relayTracing.ts";

it.effect("exports relay failures without secret-bearing messages, names or stacks", () =>
  Effect.gen(function* () {
    const exits: Array<Exit.Exit<unknown, unknown>> = [];
    const delegate = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          exits.push(exit);
        };
        return span;
      },
    });
    const failure = Object.assign(
      new Error("secret-message", { cause: new Error("secret-cause") }),
      { name: "secret-name", stack: "secret-stack" },
    );
    yield* Effect.fail(failure).pipe(
      Effect.withSpan("relay.attempt"),
      Effect.withTracer(nonInterferingTracer(delegate)),
      Effect.ignore,
    );
    const exit = exits[0];
    if (exit === undefined || !Exit.isFailure(exit)) throw new Error("expected a failed span");
    const text = Cause.prettyErrors(exit.cause)
      .map((error) => `${error.name}\n${error.message}\n${error.stack}`)
      .join("\n");
    expect(text).not.toContain("secret-");
  }),
);

it.effect("drops unrecognized attributes even on child spans", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const collector = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    yield* Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "unexpected.secret": "sentinel-id",
        "environment.id": "sentinel-id",
        "http.response.status_code": 200,
      });
      const span = yield* Effect.currentSpan;
      if (span.attributes instanceof Map) span.attributes.set("direct.secret", "sentinel-id");
      span.event("sentinel-id", 0n, { "unexpected.secret": "sentinel-id" });
      if (Array.isArray(span.links)) {
        span.links.push({
          span: Tracer.externalSpan({
            spanId: "abcdef1234567890",
            traceId: "abcdef1234567890abcdef1234567890",
          }),
          attributes: { secret: "sentinel-id" },
        });
      }
      span.addLinks([
        {
          span: Tracer.externalSpan({
            spanId: "1234567890abcdef",
            traceId: "1234567890abcdef1234567890abcdef",
          }),
          attributes: { secret: "sentinel-id" },
        },
      ]);
      yield* Effect.void.pipe(
        Effect.withSpan("sentinel-id", {
          attributes: { "url.full": "https://relay.test/sentinel-id" },
        }),
      );
    }).pipe(Effect.withSpan("relay.parent"), Effect.withTracer(nonInterferingTracer(collector)));
    expect(spans.map((span) => JSON.stringify([...span.attributes])).join("\n")).not.toContain(
      "sentinel-id",
    );
    expect(spans[0]?.attributes.get("http.response.status_code")).toBe(200);
    expect(spans.map((span) => span.name)).not.toContain("sentinel-id");
    expect(spans.flatMap((span) => span.events)).toEqual([]);
    expect(
      JSON.stringify(spans.flatMap((span) => span.links).map((link) => link.attributes)),
    ).not.toContain("sentinel-id");
  }),
);
