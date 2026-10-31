import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { ScreenHostCall, ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import { call, context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { CellWindowTracker, withInputTiming } from "./DesktopWindows.ts";
import { finishCellTracker } from "./DesktopEvidence.ts";
import { terminalFailure } from "../cua/ComputerUseTerminal.ts";

it.effect.each(["stopped_by_person", "screen_locked"] as const)(
  "end-of-cell read keeps terminal %s",
  (reason) =>
    Effect.gen(function* () {
      const tracker = new CellWindowTracker();
      tracker.recordBefore(42, undefined);
      const failure = terminalFailure({ reason, possibleCommit: false }, "list_windows", {});
      if (failure === undefined) return yield* Effect.die("missing terminal failure");
      const result = yield* finishCellTracker(
        { tracker, connectionGeneration: "driver:one" },
        context,
        { cellDeadlineMillis: 10000 },
        () => Effect.fail(failure),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe(reason);
    }),
);

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

const otherCell = { ...context, cellId: "c2" };

it.effect(
  "an element click sends only the click, with the cell's baseline taken from its bind",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_windows: { windows: [win] },
        get_window_state: calculator,
        click: { effect: "unverifiable" },
        verify_state: unchanged,
      });
      const { ref, element } = yield* bound(host);
      const first = sent.length;
      const done = yield* answersWithoutSettle(
        host.invoke(at(10_000, call("click", { elementRef: element("All Clear") }, ref)), context),
      );
      expect(sent.slice(first).map((each) => each.tool)).toEqual(["click"]);
      expect(done.category).toBe("unverifiable");
      expect(done.value).not.toHaveProperty("windows");
      expect(done.evidence ?? []).toEqual([]);
    }),
);

it.effect(
  "an input leaves the driver's window watch to the next observe unless it asks to verify",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_windows: { windows: [win] },
        get_window_state: calculator,
        click: { effect: "unverifiable" },
        press_key: { effect: "unverifiable" },
        verify_state: unchanged,
      });
      const { ref, element } = yield* bound(host);
      yield* host.invoke(at(10_000, call("press_key", { key: "Enter" }, ref)), context);
      yield* answersAfterWindowReads(
        host.invoke(
          at(10_000, call("click", { elementRef: element("All Clear"), verify: true }, ref)),
          context,
        ),
      );
      const inputs = sent.filter((each) => each.tool === "press_key" || each.tool === "click");
      expect(inputs[0]?.args).toMatchObject({ post_action_wait: "none" });
      expect(inputs[1]?.args).not.toHaveProperty("post_action_wait");
    }),
);

// A verified input whose windows did not change reads them again a few times, 100 ms apart.
const answersAfterWindowReads = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkChild);
    yield* TestClock.adjust("299 millis");
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 millis");
    return yield* Fiber.join(fiber);
  });
const aroundVerifiedInput = (input: string) => [
  "list_windows",
  input,
  "list_windows",
  "list_windows",
  "list_windows",
  "list_windows",
];

it.effect("a key without modifiers that asks to verify reads the windows around it", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_windows: { windows: [win] },
      get_window_state: calculator,
      press_key: { effect: "unverifiable" },
    });
    const { ref } = yield* bound(host);
    const first = sent.length;
    const done = yield* answersAfterWindowReads(
      host.invoke(at(10_000, call("press_key", { key: "Enter", verify: true }, ref)), context),
    );
    expect(sent.slice(first).map((each) => each.tool)).toEqual(aroundVerifiedInput("press_key"));
    expect((done.value as { windows?: { bound?: string } }).windows?.bound).toBe("present");
  }),
);

it.effect("a click that asks to verify reads the windows around the input", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_windows: { windows: [win] },
      get_window_state: calculator,
      click: { effect: "unverifiable" },
      verify_state: unchanged,
    });
    const { ref, element } = yield* bound(host);
    const first = sent.length;
    const done = yield* answersAfterWindowReads(
      host.invoke(
        at(10_000, call("click", { elementRef: element("All Clear"), verify: true }, ref)),
        context,
      ),
    );
    expect(sent.slice(first).map((each) => each.tool)).toEqual(aroundVerifiedInput("click"));
    expect(sent.find((each) => each.tool === "click")?.args).not.toHaveProperty("verify");
    expect(done.category).toBe("unverifiable");
    expect((done.value as { windows?: { bound?: string } }).windows?.bound).toBe("present");
  }),
);

it.effect(
  "the first input on a process in a cell reads one baseline, and later inputs read nothing",
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
        host.invoke(at(10_000, call("press_key", { key: "Escape" }, ref)), otherCell),
      );
      expect(sent.slice(first).map((each) => each.tool)).toEqual(["list_windows", "press_key"]);
      const second = sent.length;
      const done = yield* answersWithoutSettle(
        host.invoke(at(10_000, call("press_key", { key: "Escape" }, ref)), otherCell),
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
      yield* host.invoke(call("press_key", { key: "Escape" }, ref), otherCell);
      expect(sent.slice(first).map((each) => each.tool)).toEqual(["press_key"]);
      const cell = yield* host.finishCell!(otherCell, { cellDeadlineMillis: 10_000 });
      expect(cell.windowsOpenedUnverified).toBe(true);
    }),
);

it.effect("an input the driver reports done never reads a window to confirm it", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_windows: { windows: [win] },
      get_window_state: calculator,
      press_key: { effect: "confirmed" },
    });
    const { ref } = yield* bound(host);
    const first = sent.length;
    const key = yield* host.invoke(at(10_000, call("press_key", { key: "Enter" }, ref)), context);
    expect(key.category).toBe("confirmed");
    // A close shortcut proves nothing without a window list, so it is not reported as done.
    const close = yield* host.invoke(
      at(10_000, call("press_key", { key: "w", modifiers: ["command"] }, ref)),
      context,
    );
    expect(close.category).toBe("unverifiable");
    expect(sent.slice(first).map((each) => each.tool)).toEqual(["press_key", "press_key"]);
  }),
);

it.effect("a refused or failed input stays a typed error with no read around it", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_windows: { windows: [win] },
      get_window_state: calculator,
      click: new DriverError({ status: "failed" }, "the element is gone"),
    });
    const { ref, element } = yield* bound(host);
    const first = sent.length;
    const failed = yield* host
      .invoke(at(10_000, call("click", { elementRef: element("All Clear") }, ref)), context)
      .pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    expect(sent.slice(first).map((each) => each.tool)).toEqual(["click"]);
  }),
);

it.effect(
  "a tree read after an input waits only for what is left of the settle time, unless the cell is nearly over",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_windows: { windows: [win] },
        get_window_state: calculator,
        click: { effect: "unverifiable" },
      });
      const { ref, element } = yield* bound(host);
      const reads = () => sent.filter((each) => each.tool === "get_window_state").length;
      yield* host.invoke(
        at(10_000, call("click", { elementRef: element("All Clear") }, ref)),
        context,
      );
      const before = reads();
      // 40 ms pass after the input, so the read owes 20 ms more.
      yield* TestClock.adjust("40 millis");
      const read = yield* host
        .observe(at(10_000, call("get_window_state", {}, ref)), context)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("19 millis");
      expect(reads()).toBe(before);
      yield* TestClock.adjust("1 millis");
      const fresh = (yield* Fiber.join(read)).value as ScreenObservation;
      expect(reads()).toBe(before + 1);

      // Once 60 ms have passed since the input, the next read goes out at once.
      const clear = fresh.elements.find((each) => each.name === "All Clear")!.ref;
      yield* host.invoke(at(10_000, call("click", { elementRef: clear }, ref)), context);
      yield* TestClock.adjust("60 millis");
      const late = reads();
      const latest = (yield* host.observe(at(10_000, call("get_window_state", {}, ref)), context))
        .value as ScreenObservation;
      expect(reads()).toBe(late + 1);

      const again = latest.elements.find((each) => each.name === "All Clear")!.ref;
      yield* answersWithoutSettle(
        host.invoke(at(10_000, call("click", { elementRef: again }, ref)), context),
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
        yield* TestClock.adjust("1 second");
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
    ).toEqual({ ms: 7, phases: { driverMs: 7 } });
    // The reads before and after the input run side by side, so each phase costs its slowest read;
    // with no window opened, the listing is read three more times, 100 ms apart.
    expect(
      yield* timed(
        at(10_000, call("click", { elementRef: named("Secondary Functions"), verify: true }, ref)),
      ),
    ).toEqual({ ms: 379, phases: { preMs: 3, driverMs: 7, settleMs: 60, postMs: 309 } });
    expect(yield* timed(at(10_000, call("press_key", { key: "Escape" }, ref)))).toEqual({
      ms: 5,
      phases: { driverMs: 5 },
    });
  }),
);

it("an answer keeps its timing exactly while both the host value and the guest's Done fit returnBytes", () => {
  const timing = { ms: 0, phases: { driverMs: 0 } };
  // Nothing answered: the guest's Done is the verdict and the timing, with no result.
  const host = JSON.stringify({ _timing: timing, _noResult: true }).length;
  const guest = JSON.stringify({ verdict: "unverifiable", ...timing }).length;
  const limit = Math.max(host, guest);
  expect(withInputTiming(undefined, timing, limit)).toEqual({ _timing: timing, _noResult: true });
  expect(withInputTiming(undefined, timing, limit - 1)).toBeUndefined();
  // An empty answer stays an empty result.
  const empty = JSON.stringify({ verdict: "unverifiable", ...timing, result: {} }).length;
  expect(withInputTiming({}, timing, empty)).toEqual({ _timing: timing });
  expect(withInputTiming({}, timing, empty - 1)).toEqual({});
});
