import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import {
  call,
  context,
  DriverError,
  fixture,
  UnknownOutcome,
} from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

type Host = ReturnType<typeof fixture>["host"];

const shown = (id: number, extra: Record<string, unknown> = {}) => ({
  pid: 42,
  window_id: id,
  title: `W${id}`,
  layer: 0,
  is_on_screen: true,
  bounds: { x: 0, y: 0, width: 400, height: 300 },
  ...extra,
});
/** A pid-scoped list_windows answer; a complete one carries the authoritative id snapshot. */
const listing = (ids: readonly number[], complete = true) => ({
  windows: ids.map((id) => shown(id)),
  enumeration_complete: complete,
  ...(complete ? { authoritative_window_ids: [...ids] } : {}),
});

/**
 * A process whose windows are `before` until an input acts and then `after`, one answer per
 * read after the input (the last repeats), so a late window change takes several reads to show.
 */
const desktop = (
  before: unknown,
  after: readonly unknown[],
  input: unknown = { effect: "unverifiable" },
) => {
  const state = { acted: false, readsAfter: 0 };
  const act = () => {
    state.acted = true;
    return input;
  };
  const made = fixture({
    list_windows: () =>
      state.acted ? after[Math.min(state.readsAfter++, after.length - 1)] : before,
    press_key: act,
    click: act,
    get_window_state: {
      pid: 42,
      window_id: 7,
      tree_markdown:
        '- [0] AXWindow "W7"\n  - [1] AXButton (close button) [actions=[press]]\n  - [2] AXButton "Apply" [actions=[press]]',
      elements_complete: false,
      elements: [
        { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "W7" },
        {
          role: "AXButton",
          element_index: 1,
          element_token: "s1:1",
          label: "close button",
          actions: ["AXPress"],
        },
        {
          role: "AXButton",
          element_index: 2,
          element_token: "s1:2",
          label: "Apply",
          actions: ["AXPress"],
        },
      ],
    },
  });
  return { ...made, state };
};

const bind = (host: Host) =>
  host
    .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
    .pipe(Effect.map((bound) => bound.value as ScreenTargetRef));

/** One input, with the test clock moved past every re-read the input may wait for. */
const input = (
  host: Host,
  ref: ScreenTargetRef,
  method: "press_key" | "click",
  args: Parameters<typeof call>[1],
) =>
  Effect.gen(function* () {
    const fiber = yield* host
      .invoke(
        { ...call(method, { ...(args as object), verify: true }, ref), deadlineMillis: 10_000 },
        context,
      )
      .pipe(Effect.result, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    return yield* Fiber.join(fiber);
  });
const ok = <A, E>(result: { _tag: "Success"; success: A } | { _tag: "Failure"; failure: E }) => {
  if (result._tag === "Failure") throw new Error(`input failed: ${JSON.stringify(result.failure)}`);
  return result.success;
};
const press = (key: string) => ({ key, modifiers: ["command"] });
const boundOf = (value: unknown) => (value as { windows?: { bound?: string } }).windows?.bound;

/** Runs one cell through the real guest runtime against the fixture host. */
const runCellOn = (host: Host, source: string) => {
  const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({ ...turn, invocation: context.invocation, source });
    yield* service.finishTurn({ ...turn, reason: "test" });
    return result;
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        desktopHost: host,
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
};

it.effect(
  "a key that opens a window is confirmed once its id enters the process's complete id snapshot",
  () =>
    Effect.gen(function* () {
      const { host } = desktop(listing([7]), [listing([7, 8])]);
      const out = ok(yield* input(host, yield* bind(host), "press_key", press("t")));
      expect(out.category).toBe("confirmed");
      expect(out.evidence).toContain("observed:window_opened:8");
      expect(out.safety?.possibleCommit).toBe(true);
      expect(out.safety?.writeStatus).not.toBe("may_have_applied");
    }),
);

it.effect("a window that shows after the key returned is read again until it does", () =>
  Effect.gen(function* () {
    const { host, state } = desktop(listing([7]), [listing([7]), listing([7]), listing([7, 8])]);
    const out = ok(yield* input(host, yield* bind(host), "press_key", press("n")));
    expect(out.category).toBe("confirmed");
    expect(out.evidence).toContain("observed:window_opened:8");
    expect(state.readsAfter).toBe(3);
  }),
);

it.effect(
  "a click that opens a top-level window is confirmed; a menu it shows is not a window",
  () =>
    Effect.gen(function* () {
      const opened = desktop(listing([7]), [listing([7, 8])]);
      const out = ok(
        yield* input(opened.host, yield* bind(opened.host), "click", { x: 10, y: 10 }),
      );
      expect(out.category).toBe("confirmed");
      const menu = desktop(listing([7]), [
        { ...listing([7, 8]), windows: [shown(7), shown(8, { layer: 101 })] },
      ]);
      const menuOut = ok(
        yield* input(menu.host, yield* bind(menu.host), "click", { x: 10, y: 10 }),
      );
      expect(menuOut.category).toBe("unverifiable");
    }),
);

it.effect(
  "a new window in an incomplete listing, before or after the key, stays unverifiable",
  () =>
    Effect.gen(function* () {
      for (const [before, after] of [
        [listing([7]), listing([7, 8], false)],
        [listing([7], false), listing([7, 8])],
      ] as const) {
        const { host } = desktop(before, [after]);
        const out = ok(yield* input(host, yield* bind(host), "press_key", press("t")));
        expect(out.category).toBe("unverifiable");
        expect(out.evidence).toContain("observed:window_opened:8");
      }
    }),
);

it.effect(
  "cmd+w and cmd+q are confirmed when the window, or the whole process, leaves the complete snapshot",
  () =>
    Effect.gen(function* () {
      for (const [key, after] of [
        ["w", listing([9])],
        ["q", listing([])],
      ] as const) {
        const { host } = desktop(listing([7, 9]), [after]);
        const out = ok(yield* input(host, yield* bind(host), "press_key", press(key)));
        expect(out.category).toBe("confirmed");
        expect(out.evidence).toContain("observed:window_closed");
        expect(boundOf(out.value)).toBe("closed");
      }
    }),
);

it.effect("a window that closes after cmd+q returned is read again until it is gone", () =>
  Effect.gen(function* () {
    const { host, state } = desktop(listing([7]), [listing([7]), listing([7]), listing([])]);
    const out = ok(yield* input(host, yield* bind(host), "press_key", press("q")));
    expect(out.category).toBe("confirmed");
    expect(state.readsAfter).toBe(3);
  }),
);

it.effect("a close the listing cannot prove, because it is incomplete, stays unverifiable", () =>
  Effect.gen(function* () {
    const { host, state } = desktop(listing([7, 9]), [listing([9], false)]);
    const out = ok(yield* input(host, yield* bind(host), "press_key", press("w")));
    expect(out.category).toBe("unverifiable");
    expect(out.evidence).not.toContain("observed:window_closed");
    // It read again a bounded number of times, then gave up.
    expect(state.readsAfter).toBe(5);
  }),
);

it.effect(
  "the close button is confirmed by closure; another button whose window closed keeps the driver's verdict",
  () =>
    Effect.gen(function* () {
      for (const [index, category] of [
        [1, "confirmed"],
        [2, "unverifiable"],
      ] as const) {
        const { host } = desktop(listing([7, 9]), [listing([9])]);
        const ref = yield* bind(host);
        const seen = (yield* host.observe(call("get_window_state", {}, ref), context))
          .value as ScreenObservation;
        const button = seen.elements.find((element) => element.index === index);
        if (!button) throw new Error("missing button");
        const out = ok(yield* input(host, ref, "click", { elementRef: button.ref }));
        expect(out.category).toBe(category);
        expect(out.evidence).toContain("observed:window_closed");
      }
    }),
);

it.effect(
  "a close the driver answered with an error after sending succeeds when the window is gone",
  () =>
    Effect.gen(function* () {
      const cut = new UnknownOutcome({ code: "tool_call_timeout" }, "cut off");
      const closed = desktop(listing([7, 9]), [listing([9])], cut);
      const out = ok(yield* input(closed.host, yield* bind(closed.host), "press_key", press("w")));
      expect(out.category).toBe("confirmed");
      const still = desktop(listing([7, 9]), [listing([7, 9])], cut);
      const failed = yield* input(still.host, yield* bind(still.host), "press_key", press("w"));
      expect(failed._tag === "Failure" && failed.failure.code).toBe("unknown_outcome");
    }),
);

it.effect("observing a window that closed names it gone instead of a driver failure", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      get_window_state: new DriverError({ code: "window_id_not_found" }, "window 7 not found"),
    });
    const ref = yield* bind(host);
    const failed = yield* host
      .observe(call("get_window_state", {}, ref), context)
      .pipe(Effect.flip);
    expect(failed).toMatchObject({
      code: "target_missing",
      detail: "window_gone",
      effectStarted: false,
    });
  }),
);

it.live(
  "an unverifiable input does not stop the cell's next inputs, before or after a confirmed close",
  () => {
    let closed = false;
    const { host, sent } = fixture({
      list_windows: () => (closed ? listing([9]) : listing([7, 9])),
      press_key: (args: unknown) => {
        if ((args as { key?: string }).key === "w") closed = true;
        return { effect: "unverifiable" };
      },
    });
    return Effect.gen(function* () {
      const result = yield* runCellOn(
        host,
        "const a = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "const first = await a.press('cmd+a', {verify: true}); const second = await a.press('cmd+w', {verify: true}); " +
          "const b = await screen.app({bundle_id: 'org.example.Editor', window_id: 9}); " +
          "const third = await b.press('cmd+a', {verify: true}); return [first.verdict, second.verdict, third.verdict];",
      );
      expect(result.value).toEqual(["unverifiable", "confirmed", "unverifiable"]);
      expect(sent.filter((each) => each.tool === "press_key")).toHaveLength(3);
    });
  },
);

it.effect("cmd+w that opens a save sheet over a window that stays open is not confirmed", () =>
  Effect.gen(function* () {
    const { host } = desktop(listing([7]), [listing([7, 8])]);
    const out = ok(yield* input(host, yield* bind(host), "press_key", press("w")));
    expect(out.category).toBe("unverifiable");
    expect(out.evidence).toContain("observed:window_opened:8");
    expect(boundOf(out.value)).toBe("present");
  }),
);

it.effect(
  "a window the complete snapshot names before the listing shows its row is confirmed",
  () =>
    Effect.gen(function* () {
      const { host } = desktop(listing([7]), [
        { windows: [shown(7)], enumeration_complete: true, authoritative_window_ids: [7, 8] },
      ]);
      const out = ok(yield* input(host, yield* bind(host), "press_key", press("t")));
      expect(out.category).toBe("confirmed");
      expect(out.evidence).toContain("observed:window_opened:8");
    }),
);

it.effect(
  "a new window first listed incompletely is read again until a complete listing proves it",
  () =>
    Effect.gen(function* () {
      const { host, state } = desktop(listing([7]), [listing([7, 8], false), listing([7, 8])]);
      const out = ok(yield* input(host, yield* bind(host), "press_key", press("t")));
      expect(out.category).toBe("confirmed");
      expect(state.readsAfter).toBe(2);
    }),
);

it.effect("a click by point the driver says hit the close button is confirmed by closure", () =>
  Effect.gen(function* () {
    const { host } = desktop(listing([7, 9]), [listing([9])], {
      effect: "unverifiable",
      hit: { role: "AXButton", label: "close button" },
    });
    const out = ok(yield* input(host, yield* bind(host), "click", { x: 10, y: 10 }));
    expect(out.category).toBe("confirmed");
    expect(boundOf(out.value)).toBe("closed");
  }),
);

it.effect(
  "an input the driver says may have acted on a window it no longer finds keeps that safety",
  () =>
    Effect.gen(function* () {
      const { host } = desktop(
        listing([7]),
        [listing([7])],
        new DriverError(
          { effect: "unverifiable", code: "window_id_not_found" },
          "window 7 not found after posting",
        ),
      );
      const failed = yield* input(host, yield* bind(host), "press_key", press("a"));
      expect(failed._tag === "Failure" && failed.failure).toMatchObject({
        code: "unknown_outcome",
        effectStarted: true,
      });
    }),
);

it.effect(
  "a window the listing still shows after cmd+w, though its id left the snapshot, is unproven",
  () =>
    Effect.gen(function* () {
      const { host } = desktop(listing([7, 9]), [
        {
          windows: [shown(7), shown(9)],
          enumeration_complete: true,
          authoritative_window_ids: [9],
        },
      ]);
      const out = ok(yield* input(host, yield* bind(host), "press_key", press("w")));
      expect(out.category).toBe("unverifiable");
      expect(out.evidence).not.toContain("observed:window_closed");
    }),
);

it.effect(
  "a close the driver calls confirmed stays unverifiable until the listing shows it closed",
  () =>
    Effect.gen(function* () {
      for (const after of [
        listing([9], false),
        {
          windows: [shown(7), shown(9)],
          enumeration_complete: true,
          authoritative_window_ids: [9],
        },
      ]) {
        const { host } = desktop(listing([7, 9]), [after], {
          effect: "confirmed",
          evidence: ["driver:acted"],
        });
        const out = ok(yield* input(host, yield* bind(host), "press_key", press("w")));
        expect(out.category).toBe("unverifiable");
        expect(out.safety?.writeStatus).toBe("may_have_applied");
      }
    }),
);

it.effect(
  "a close chord written as one key, cmd+w, reads the windows and is confirmed by closure",
  () =>
    Effect.gen(function* () {
      const { host } = desktop(listing([7, 9]), [listing([9])]);
      const out = ok(yield* input(host, yield* bind(host), "press_key", { key: "cmd+w" }));
      expect(out.category).toBe("confirmed");
      expect(boundOf(out.value)).toBe("closed");
    }),
);

it.live(
  "a close button clicked in an unawaited group is judged by the listing like any close",
  () =>
    Effect.gen(function* () {
      const verdicts = [];
      for (const closes of [true, false]) {
        let closed = false;
        const { host, sent } = fixture({
          list_windows: () => (closed ? listing([9]) : listing([7, 9])),
          click: (args: unknown) => {
            if (closes && (args as { element_token?: string }).element_token === "s1:1")
              closed = true;
            return { effect: "confirmed", evidence: ["driver:acted"] };
          },
          get_window_state: {
            pid: 42,
            window_id: 7,
            tree_markdown:
              '- [0] AXWindow "W7"\n  - [1] AXButton (close button) [actions=[press]]\n  - [2] AXButton "Apply" [actions=[press]]',
            elements_complete: false,
            elements: [
              { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "W7" },
              {
                role: "AXButton",
                element_index: 1,
                element_token: "s1:1",
                label: "close button",
                actions: ["AXPress"],
              },
              {
                role: "AXButton",
                element_index: 2,
                element_token: "s1:2",
                label: "Apply",
                actions: ["AXPress"],
              },
            ],
          },
        });
        const result = yield* runCellOn(
          host,
          "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); " +
            "return (await Promise.all([app.click('Apply', {verify: true}), app.click('close button', {verify: true})])).map((done) => done.verdict);",
        );
        verdicts.push(result.value);
        expect(sent.filter((each) => each.tool === "click")).toHaveLength(2);
      }
      expect(verdicts).toEqual([
        ["confirmed", "confirmed"],
        ["confirmed", "unverifiable"],
      ]);
    }),
);

it.live(
  "a grouped click by point the driver says hit a close button is not confirmed without a listing",
  () => {
    const { host, sent } = fixture({
      list_windows: listing([7]),
      click: (args: unknown) =>
        (args as { element_token?: string }).element_token === undefined
          ? {
              effect: "confirmed",
              evidence: ["driver:acted"],
              hit: { role: "AXButton", label: "close button" },
            }
          : { effect: "confirmed", evidence: ["driver:acted"] },
    });
    return Effect.gen(function* () {
      const result = yield* runCellOn(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); " +
          "await Promise.all([app.click('Apply'), app.click({window: [10, 10]})]); return 1;",
      );
      expect(
        result.journal
          .filter((entry) => entry.receipt.method === "click")
          .map((entry) => entry.receipt.category),
      ).toEqual(["confirmed", "unverifiable"]);
      // Both clicks went out as one group: no window read between them, only the cell's end read.
      const tools = sent.map((each) => each.tool);
      expect(tools.slice(tools.indexOf("click"))).toEqual(["click", "click", "list_windows"]);
    });
  },
);

// The default path reads nothing around an input; these keep its labels and its cell report honest.
const bareInput = (
  host: Host,
  ref: ScreenTargetRef,
  method: "press_key" | "click",
  args: Parameters<typeof call>[1],
) =>
  host.invoke({ ...call(method, args, ref), deadlineMillis: 10_000 }, context).pipe(Effect.result);

it.effect("a driver's confirmed on a key that opens or closes a window stays unverifiable", () =>
  Effect.gen(function* () {
    const open = desktop(listing([7]), [listing([7, 8])], { effect: "confirmed" });
    const opened = ok(yield* bareInput(open.host, yield* bind(open.host), "press_key", press("t")));
    expect(opened.category).toBe("unverifiable");
    const close = desktop(listing([7, 9]), [listing([9])], { effect: "confirmed" });
    const closed = ok(
      yield* bareInput(close.host, yield* bind(close.host), "press_key", press("w")),
    );
    expect(closed.category).toBe("unverifiable");
    // Neither read a window list around itself.
    expect(open.sent.filter((each) => each.tool === "list_windows")).toHaveLength(1);
    expect(close.sent.filter((each) => each.tool === "list_windows")).toHaveLength(1);
  }),
);

it.live(
  "a window an input opens is in the cell's report even when it replaced every baseline window",
  () => {
    const { host } = desktop(listing([7]), [listing([8])]);
    return Effect.gen(function* () {
      const result = yield* runCellOn(
        host,
        "const a = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await a.press('cmd+t'); return 1;",
      );
      expect(result.windowsOpened?.map((each) => each.window_id)).toEqual([8]);
      expect(result.windowsOpenedUnverified).toBe(true);
    });
  },
);

it.live("a window an input opens is in the cell's report from its end read alone", () => {
  const { host, sent } = desktop(listing([7]), [listing([7, 8])]);
  return Effect.gen(function* () {
    const result = yield* runCellOn(
      host,
      "const a = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); const done = await a.press('cmd+t'); return done.verdict;",
    );
    expect(result.value).toBe("unverifiable");
    expect(result.windowsOpened?.map((each) => each.window_id)).toEqual([8]);
    expect(result.windowsOpenedUnverified).toBeUndefined();
    // The bind's list, the key, and the cell's end read: nothing around the input itself.
    expect(sent.map((each) => each.tool).filter((tool) => tool !== "list_apps")).toEqual([
      "list_windows",
      "press_key",
      "list_windows",
    ]);
  });
});
