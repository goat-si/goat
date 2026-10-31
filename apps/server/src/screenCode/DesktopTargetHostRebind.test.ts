import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";

/** A window bound and seen under driver:1, after which a new driver replaced it. */
const replaced = Effect.fn(function* () {
  const connection = { id: "driver:1" };
  const f = fixture({ get_window_state: goat2WindowState }, connection);
  const bound = yield* f.host.bindApp(
    call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
    context,
  );
  const ref = bound.value as ScreenTargetRef;
  const observed = yield* f.host.observe(call("get_window_state", {}, ref), context);
  const elementRef = (observed.value as { elements: Array<{ ref: ScreenElementRef }> }).elements[0]
    ?.ref;
  if (!elementRef) throw new Error("The observed window must have an element");
  yield* f.host.observe(call("screenshot", {}, ref), context);
  connection.id = "driver:2";
  const sentSince = (count: number) => f.sent.slice(count).map((entry) => entry.tool);
  return { ...f, ref, elementRef, before: f.sent.length, sentSince };
});

it.effect(
  "after a driver replacement a key press and a read rebind once and reach the new driver",
  () =>
    Effect.gen(function* () {
      const { host, sent, ref, before, sentSince } = yield* replaced();
      const pressed = yield* host.invoke(call("press_key", { key: "Return" }, ref), context);
      expect(pressed.category).toBe("confirmed");
      yield* host.observe(call("get_window_state", {}, ref), context);
      expect(sentSince(before)).toEqual(["list_windows", "press_key", "get_window_state"]);
      expect(sent.at(-1)?.expectedConnectionGeneration).toBe("driver:2");
    }),
);

it.effect(
  "bridge refusals name earlier turns, control changes and lost permission without driver calls",
  () =>
    Effect.gen(function* () {
      for (const [reason, expected] of [
        ["turn_ended", "The target was bound in an earlier turn."],
        ["takeover", "The control changed (takeover)."],
        ["permission_denied", "Permission was lost."],
        ["credentialRevoked", "Permission was lost."],
      ] as const) {
        const { host, sent } = fixture();
        const first = yield* host.bindApp(
          call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
          context,
        );
        const ref = first.value as ScreenTargetRef;
        const bridge = new ScreenHostBridge(undefined, host.staleTargetStep);
        bridge.setDispatcher(host);
        const nextContext = reason === "turn_ended" ? { ...context, turnId: "later" } : context;
        if (reason !== "turn_ended") {
          bridge.invalidateTargetNow(context.runId, context.turnId, ref.id, reason);
          host.invalidateTarget(ref.id, reason);
        } else host.finishTurn(context.runId, context.turnId);
        const before = sent.length;
        const result = yield* bridge.handle(
          { ...call("get_window_state", {}, ref), turnId: nextContext.turnId },
          nextContext,
        );
        expect(result && "error" in result ? result.error : undefined).toMatchObject({
          code: "stale_reference",
          nextStep: `${expected} Rebind with screen.app({ bundle_id: "org.example.Editor", window_id: 7 }).`,
        });
        expect(sent).toHaveLength(before);
      }
    }),
);

it.effect("after a driver replacement a pixel point is refused until a new screenshot", () =>
  Effect.gen(function* () {
    const { host, ref, before, sentSince } = yield* replaced();
    const click = call("click", { x: 10, y: 20 }, ref);
    const first = yield* host.invoke(click, context).pipe(Effect.flip);
    expect(first).toMatchObject({ code: "stale_reference", effectStarted: false });
    expect(first.nextStep).toContain("take a new screenshot");
    // A key press rebinds the window; the old driver's screenshot still does not carry over.
    yield* host.invoke(call("press_key", { key: "Escape" }, ref), context);
    const again = yield* host.invoke(click, context).pipe(Effect.flip);
    expect(again.nextStep).toContain("The driver restarted");
    yield* host.observe(call("screenshot", {}, ref), context);
    expect((yield* host.invoke(click, context)).category).toBe("confirmed");
    expect(sentSince(before).filter((tool) => tool === "click")).toHaveLength(1);
  }),
);

it.effect("after a driver replacement an element number is refused with the observe step", () =>
  Effect.gen(function* () {
    const { host, ref, elementRef, before, sentSince } = yield* replaced();
    const result = yield* host
      .invoke(call("click", { elementRef }, ref), context)
      .pipe(Effect.flip);
    expect(result).toMatchObject({ code: "stale_reference", effectStarted: false });
    expect(result.nextStep).toContain("observe again");
    expect(sentSince(before)).toEqual([]);
  }),
);

it.effect("rebinding a window in the same turn preserves its target and observations", () =>
  Effect.gen(function* () {
    const { host } = fixture();
    const first = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    yield* host.observe(call("get_window_state", {}, first.value as ScreenTargetRef), context);
    const again = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    expect(again.value).toEqual(first.value);
    const after = yield* host.observe(
      call("get_window_state", {}, first.value as ScreenTargetRef),
      context,
    );
    expect(after.value).toMatchObject({ indexedText: "Apply" });
  }),
);

it.effect(
  "a dropped target explains the control change and how to rebind without calling the driver",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture();
      const first = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = first.value as ScreenTargetRef;
      host.invalidateTarget(ref.id, "takeover");
      const before = sent.length;
      const failure = yield* host
        .observe(call("get_window_state", {}, ref), context)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        code: "stale_reference",
        effectStarted: false,
        nextStep:
          'The control changed (takeover). Rebind with screen.app({ bundle_id: "org.example.Editor", window_id: 7 }).',
      });
      expect(sent).toHaveLength(before);
    }),
);
