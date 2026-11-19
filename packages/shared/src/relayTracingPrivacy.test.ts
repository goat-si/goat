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
