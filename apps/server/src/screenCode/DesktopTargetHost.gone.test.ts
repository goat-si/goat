import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { ScreenObservation, ScreenRunError, ScreenTargetRef } from "@goat/contracts";
import { call, context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const bind = (host: ReturnType<typeof fixture>["host"]) =>
  host
    .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
    .pipe(Effect.map((bound) => bound.value as ScreenTargetRef));

const waitGone = (
  host: ReturnType<typeof fixture>["host"],
  ref: ScreenTargetRef,
  args: Parameters<typeof call>[1],
) => host.invoke({ ...call("wait_for", args, ref), deadlineMillis: 10_000 }, context);

it.effect("gone is met only when verify_state proves no match in a complete read", () =>
  Effect.gen(function* () {
    let checks = 0;
    const { host, sent } = fixture({
      verify_state: () => ({ status: ++checks === 1 ? "satisfied" : "unsatisfied" }),
    });
    const ref = yield* bind(host);
    const fiber = yield* waitGone(host, ref, {
      gone: true,
      role: "AXProgressIndicator",
      name: "Loading",
      timeoutMs: 500,
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("500 millis");
    expect((yield* Fiber.join(fiber)).value).toEqual({ met: true });
    const verifies = sent.filter((each) => each.tool === "verify_state");
    expect(verifies).toHaveLength(2);
    expect(verifies[0]?.args).toMatchObject({
      timeout_ms: 0,
      expect: [
        {
          element: {
            selector: { role: "AXProgressIndicator", label_contains: "Loading" },
            exists: true,
          },
        },
      ],
    });
    expect(sent.filter((each) => each.tool === "get_window_state")).toHaveLength(0);
  }),
);

it.effect("gone reports an unproven absence and a remaining match on timeout", () =>
  Effect.gen(function* () {
    for (const [status, reason] of [
      ["unknown", "incomplete_read"],
      ["satisfied", "still_present"],
    ] as const) {
      const { host } = fixture({ verify_state: { status } });
      const ref = yield* bind(host);
      const fiber = yield* waitGone(host, ref, {
        gone: true,
        name: "Loading",
        timeoutMs: 200,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      expect((yield* Fiber.join(fiber)).value).toEqual({ met: false, reason });
    }
  }),
);

it.effect("a failed check fails the gone wait instead of reporting it met", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      verify_state: new DriverError({ code: "downstream_failure" }),
    });
    const ref = yield* bind(host);
    const failure = (yield* waitGone(host, ref, {
      gone: true,
      name: "Loading",
      timeoutMs: 200,
    }).pipe(Effect.flip)) as ScreenRunError;
    expect(failure.code).not.toBe("invalid_argument");
  }),
);

it.effect("gone needs role, name or value and refuses other condition fields unsent", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ verify_state: { status: "unsatisfied" } });
    const ref = yield* bind(host);
    for (const args of [
      { gone: true },
      { gone: true, name: "Loading", enabled: true },
      { gone: true, name: "Loading", window: "exists" },
      { gone: "yes", name: "Loading" },
    ]) {
      const failure = (yield* waitGone(host, ref, args).pipe(Effect.flip)) as ScreenRunError;
      expect(failure.code).toBe("invalid_argument");
    }
    expect(sent.filter((each) => each.tool === "verify_state")).toHaveLength(0);
  }),
);

it.effect("a gone wait keeps the numbers from the observe before it", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ verify_state: { status: "unsatisfied" } });
    const ref = yield* bind(host);
    const observed = (yield* host.observe(call("get_window_state", {}, ref), context))
      .value as ScreenObservation;
    const elementRef = observed.elements[0]?.ref;
    if (elementRef === undefined) throw new Error("The observed window must have an element");
    yield* waitGone(host, ref, { gone: true, name: "Loading", timeoutMs: 0 });
    yield* host.invoke(call("click", { elementRef }, ref), context);
    expect(sent.filter((each) => each.tool === "click")).toHaveLength(1);
  }),
);
