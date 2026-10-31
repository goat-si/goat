import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { ScreenTargetRef } from "@goat/contracts";
import { call, context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const present = {
  role: "AXProgressIndicator",
  label: "Loading",
  element_token: "s:1",
  value: "busy",
};
const read = (elements: unknown[], extra = {}) => ({
  pid: 42,
  window_id: 7,
  elements_complete: true,
  elements,
  tree_markdown: "",
  ...extra,
});

it.effect("gone waits for a complete whole-window read with no matching element", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { host, sent } = fixture({
      get_window_state: () => read(++reads === 1 ? [present] : []),
    });
    const ref = (yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    )).value as ScreenTargetRef;
    const fiber = yield* host
      .invoke(
        {
          ...call(
            "wait_for",
            { gone: true, role: "progressindicator", name: "loading", timeoutMs: 500 },
            ref,
          ),
          deadlineMillis: 10000,
        },
        context,
      )
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("500 millis");
    expect((yield* Fiber.join(fiber)).value).toEqual({ met: true });
    expect(reads).toBe(2);
    expect(sent.filter((s) => s.tool === "get_window_state")).toHaveLength(2);
  }),
);

it.effect("gone reports incomplete reads and remaining matches on timeout", () =>
  Effect.gen(function* () {
    for (const [reply, reason] of [
      [read([], { truncated: true }), "incomplete_read"],
      [read([present]), "still_present"],
    ] as const) {
      const { host } = fixture({ get_window_state: reply });
      const ref = (yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      )).value as ScreenTargetRef;
      const fiber = yield* host
        .invoke(
          {
            ...call("wait_for", { gone: true, name: "Loading", timeoutMs: 200 }, ref),
            deadlineMillis: 10000,
          },
          context,
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      expect((yield* Fiber.join(fiber)).value).toEqual({ met: false, reason });
    }
  }),
);

it.effect("gone never succeeds when a later driver read fails", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { host } = fixture({
      get_window_state: () =>
        ++reads === 1 ? read([present]) : new DriverError({ code: "downstream_failure" }),
    });
    const ref = (yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    )).value as ScreenTargetRef;
    const fiber = yield* Effect.exit(
      host.invoke(
        {
          ...call("wait_for", { gone: true, name: "Loading", timeoutMs: 500 }, ref),
          deadlineMillis: 10000,
        },
        context,
      ),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("500 millis");
    const result = yield* Fiber.join(fiber);
    expect(
      result._tag === "Failure" ||
        (result._tag === "Success" && (result.value.value as { met: boolean }).met === false),
    ).toBe(true);
  }),
);
