import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import {
  call,
  context,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";

/**
 * What the pinned driver (cua-driver 0.38.0-goat.8) accepts: a per-call target only for the tools
 * in cua-driver-core/src/action_target.rs:6-14, and for these two tools only the properties of
 * platform-macos/src/tools/set_value.rs:61-77 and right_click.rs:39-65 (additionalProperties false).
 */
const TARGETED = new Set([
  "move_cursor",
  "click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
]);
const SCHEMA: Readonly<Record<string, ReadonlySet<string>>> = {
  set_value: new Set(["session", "pid", "window_id", "element_token", "value", "post_action_wait"]),
  right_click: new Set([
    "session",
    "pid",
    "element_token",
    "window_id",
    "x",
    "y",
    "modifier",
    "delivery_mode",
    "post_action_wait",
  ]),
};
/** Answers a call as the driver would: refused before it runs unless its arguments fit. */
const driverChecked = (tool: string) => (args: Record<string, unknown>) => {
  if ("target" in args && !TARGETED.has(tool))
    return new DriverError(
      { code: "invalid_action_target" },
      `${tool} does not accept a per-call target`,
    );
  const unknown = Object.keys(args).filter((key) => !SCHEMA[tool]?.has(key));
  if (unknown.length > 0)
    return new DriverError({ code: "invalid_arguments" }, `unknown: ${unknown.join(", ")}`);
  return { effect: "confirmed", evidence: ["driver:acted"] };
};

const bound = Effect.fn(function* () {
  const f = fixture({
    get_window_state: goat2WindowState,
    set_value: driverChecked("set_value"),
    right_click: driverChecked("right_click"),
  });
  const binding = yield* f.host.bindApp(
    call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
    context,
  );
  const ref = binding.value as ScreenTargetRef;
  const observed = yield* f.host.observe(call("get_window_state", {}, ref), context);
  const elementRef = (observed.value as { elements: Array<{ ref: ScreenElementRef }> }).elements[0]
    ?.ref;
  if (!elementRef) throw new Error("The observed window must have an element");
  return { ...f, ref, elementRef };
});

it.effect("setValue and a right click reach the driver with the arguments it takes", () =>
  Effect.gen(function* () {
    const { host, sent, ref, elementRef } = yield* bound();
    const set = yield* host.invoke(call("set_value", { value: "hello", elementRef }, ref), context);
    expect(set.category).toBe("confirmed");
    const onElement = yield* host.invoke(call("right_click", { elementRef }, ref), context);
    expect(onElement.category).toBe("confirmed");
    yield* host.observe(call("screenshot", {}, ref), context);
    const atPoint = yield* host.invoke(call("right_click", { x: 10, y: 20 }, ref), context);
    expect(atPoint.category).toBe("confirmed");
    const forwarded = sent.filter(
      (entry) => entry.tool === "set_value" || entry.tool === "right_click",
    );
    // An element token carries its window, so only a point names the window itself.
    expect(forwarded.map((entry) => entry.args)).toEqual([
      { value: "hello", pid: 42, element_token: "s0000000a:0", post_action_wait: "none" },
      {
        delivery_mode: "background",
        pid: 42,
        element_token: "s0000000a:0",
        post_action_wait: "none",
      },
      {
        x: 10,
        y: 20,
        delivery_mode: "background",
        pid: 42,
        window_id: 7,
        post_action_wait: "none",
      },
    ]);
  }),
);

it.effect("setValue with an element from another window is refused before it is sent", () =>
  Effect.gen(function* () {
    const { host, sent, ref, elementRef } = yield* bound();
    const other = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const result = yield* host
      .invoke(
        call("set_value", { value: "x", elementRef }, other.value as ScreenTargetRef),
        context,
      )
      .pipe(Effect.flip);
    expect(result.code).toBe("stale_reference");
    expect(sent.filter((entry) => entry.tool === "set_value")).toHaveLength(0);
    expect(ref).not.toEqual(other.value);
  }),
);
