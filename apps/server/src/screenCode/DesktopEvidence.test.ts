import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { ScreenHostCall, ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";

const at = (deadlineMillis: number, each: ScreenHostCall): ScreenHostCall => ({
  ...each,
  deadlineMillis,
});
const win = { pid: 42, window_id: 7, title: "Calculator", is_on_screen: true };
// A calculator: a stateless button, a display whose value changes, and a stateful checkbox.
const calculator = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s1",
  elements_complete: false,
  tree_markdown: [
    '- [0] AXWindow "Calculator"',
    '  - [1] AXStaticText "Display" = "5"',
    '  - [2] AXButton "All Clear" [actions=[press]]',
    '  - [3] AXCheckBox "Secondary Functions" = "0" [actions=[press]]',
  ].join("\n"),
  elements: [
    { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "Calculator" },
    { role: "AXStaticText", element_index: 1, element_token: "s1:1", label: "Display", value: "5" },
    {
      role: "AXButton",
      element_index: 2,
      element_token: "s1:2",
      label: "All Clear",
      actions: ["AXPress"],
    },
    {
      role: "AXCheckBox",
      element_index: 3,
      element_token: "s1:3",
      label: "Secondary Functions",
      value: "0",
      selected: false,
      actions: ["AXPress"],
    },
  ],
};
const unchanged = (args: { expect?: ReadonlyArray<unknown> }) => ({
  status: "satisfied",
  predicates: (args.expect ?? []).map((_, index) => ({ index, status: "satisfied" })),
});

const bound = (host: ReturnType<typeof fixture>["host"]) =>
  Effect.gen(function* () {
    const ref = (yield* host.bindApp(
      at(10_000, call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 })),
      context,
    )).value as ScreenTargetRef;
    const observation = (yield* host.observe(
      at(10_000, call("get_window_state", {}, ref)),
      context,
    )).value as ScreenObservation;
    const element = (name: string) => {
      const found = observation.elements.find((each) => each.name === name);
      if (!found) throw new Error(`Missing ${name}`);
      return found.ref;
    };
    return { ref, element };
  });

/** Runs an input and proves it answered before a 60 ms settle could have elapsed. */
const answersWithoutSettle = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkChild);
    yield* TestClock.adjust("59 millis");
    expect(fiber.pollUnsafe()).toBeDefined();
    return yield* Fiber.join(fiber);
  });

it.effect("a stateless element click sends no verify_state and answers without a settle", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_windows: { windows: [win] },
      get_window_state: calculator,
      click: { effect: "unverifiable" },
      verify_state: unchanged,
    });
    const { ref, element } = yield* bound(host);
    const done = yield* answersWithoutSettle(
      host.invoke(at(10_000, call("click", { elementRef: element("All Clear") }, ref)), context),
    );
    expect(done.category).toBe("unverifiable");
    expect(sent.filter((each) => each.tool === "verify_state")).toHaveLength(0);
    expect((done.value as { windows?: { bound?: string } }).windows?.bound).toBe("present");
  }),
);

it.effect(
  "an untargeted key without modifiers sends only the key once the cell has a baseline",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_windows: { windows: [win] },
        get_window_state: calculator,
        press_key: { effect: "unverifiable" },
        verify_state: unchanged,
      });
      const { ref } = yield* bound(host);
      const first = sent.length;
      yield* answersWithoutSettle(
        host.invoke(at(10_000, call("press_key", { key: "Escape" }, ref)), context),
      );
      expect(sent.slice(first).map((each) => each.tool)).toEqual(["list_windows", "press_key"]);
      const second = sent.length;
      const done = yield* answersWithoutSettle(
        host.invoke(at(10_000, call("press_key", { key: "Escape" }, ref)), context),
      );
      expect(sent.slice(second).map((each) => each.tool)).toEqual(["press_key"]);
      expect(done.value).not.toHaveProperty("windows");
    }),
);

it.effect(
  "a key with too little cell left for its baseline is still sent, and the cell says windows are unverified",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_windows: { windows: [win] },
        get_window_state: calculator,
        press_key: { effect: "unverifiable" },
      });
      const { ref } = yield* bound(host);
      const first = sent.length;
      // The testkit's 1,000 ms deadline leaves no room for a list_windows before the key's own cap.
      yield* host.invoke(call("press_key", { key: "Escape" }, ref), context);
      expect(sent.slice(first).map((each) => each.tool)).toEqual(["press_key"]);
      const cell = yield* host.finishCell!(context, { cellDeadlineMillis: 10_000 });
      expect(cell.windowsOpenedUnverified).toBe(true);
    }),
);

it.effect(
  "a tree read after an unsettled input waits out the settle first, unless the cell is nearly over",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_windows: { windows: [win] },
        get_window_state: calculator,
        click: { effect: "unverifiable" },
      });
      const { ref, element } = yield* bound(host);
      const reads = () => sent.filter((each) => each.tool === "get_window_state").length;
      yield* answersWithoutSettle(
        host.invoke(at(10_000, call("click", { elementRef: element("All Clear") }, ref)), context),
      );
      const before = reads();
      const read = yield* host
        .observe(at(10_000, call("get_window_state", {}, ref)), context)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("59 millis");
      expect(reads()).toBe(before);
      yield* TestClock.adjust("1 millis");
      const fresh = (yield* Fiber.join(read)).value as ScreenObservation;
      expect(reads()).toBe(before + 1);

      const clear = fresh.elements.find((each) => each.name === "All Clear")!.ref;
      yield* answersWithoutSettle(
        host.invoke(at(10_000, call("click", { elementRef: clear }, ref)), context),
      );
      const tight = reads();
      yield* host.observe(call("get_window_state", {}, ref), context);
      expect(reads()).toBe(tight + 1);
    }),
);

it.effect("an input's result carries its total and per-phase host time", () =>
  Effect.gen(function* () {
    const base = fixture({
      list_windows: { windows: [win] },
      get_window_state: calculator,
      click: { effect: "unverifiable" },
      press_key: { effect: "unverifiable" },
      verify_state: unchanged,
    });
    const cost: Record<string, number> = {
      list_windows: 2,
      verify_state: 3,
      click: 7,
      press_key: 5,
    };
    const host = createDesktopTargetHost({
      primitiveChannel: {
        request: (request: { tool: string }) =>
          Effect.sleep(cost[request.tool] ?? 0).pipe(
            Effect.andThen(base.channel.request(request as never)),
          ),
      } as never,
      leases: base.leases,
      platform: "darwin",
    });
    const timed = (each: ScreenHostCall) =>
      Effect.gen(function* () {
        const fiber = yield* host.invoke(each, context).pipe(Effect.forkChild);
        yield* TestClock.adjust("200 millis");
        return ((yield* Fiber.join(fiber)).value as { _timing?: unknown })._timing;
      });
    const ref = (yield* host
      .bindApp(
        at(10_000, call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 })),
        context,
      )
      .pipe(
        Effect.forkChild,
        Effect.tap(() => TestClock.adjust("20 millis")),
        Effect.flatMap(Fiber.join),
      )).value as ScreenTargetRef;
    const observation = (yield* host
      .observe(at(10_000, call("get_window_state", {}, ref)), context)
      .pipe(
        Effect.forkChild,
        Effect.tap(() => TestClock.adjust("20 millis")),
        Effect.flatMap(Fiber.join),
      )).value as ScreenObservation;
    const named = (name: string) => observation.elements.find((each) => each.name === name)!.ref;

    expect(
      yield* timed(at(10_000, call("click", { elementRef: named("All Clear") }, ref))),
    ).toEqual({
      ms: 11,
      phases: { preMs: 2, driverMs: 7, postMs: 2 },
    });
    expect(
      yield* timed(at(10_000, call("click", { elementRef: named("Secondary Functions") }, ref))),
    ).toEqual({ ms: 77, phases: { preMs: 5, driverMs: 7, settleMs: 60, postMs: 5 } });
    expect(yield* timed(at(10_000, call("press_key", { key: "Escape" }, ref)))).toEqual({
      ms: 5,
      phases: { driverMs: 5 },
    });
  }),
);
