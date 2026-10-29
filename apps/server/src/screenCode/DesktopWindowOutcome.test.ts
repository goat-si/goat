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
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const fiber = yield* host
      .invoke({ ...call(method, args, ref), deadlineMillis: 10_000 }, context)
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
    const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        ...turn,
        invocation: context.invocation,
        source:
          "const a = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "const first = await a.press('cmd+a'); const second = await a.press('cmd+w'); " +
          "const b = await screen.app({bundle_id: 'org.example.Editor', window_id: 9}); " +
          "const third = await b.press('cmd+a'); return [first.verdict, second.verdict, third.verdict];",
      });
      yield* service.finishTurn({ ...turn, reason: "test" });
      expect(result.value).toEqual(["unverifiable", "confirmed", "unverifiable"]);
      expect(sent.filter((each) => each.tool === "press_key")).toHaveLength(3);
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
  },
);
