import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenTargetRef } from "@goat/contracts";
import { call, context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const document = { pid: 42, window_id: 7, title: "Document" };
const other = { pid: 42, window_id: 9, title: "Other" };

/** waitFor({window:"gone"}) after bind_app, where the driver's verify_state answers `status`. */
const waitGone = (status: string, afterBind: unknown, deadlineMillis = 10_000) =>
  Effect.gen(function* () {
    let lists = 0;
    const { host, sent } = fixture({
      list_windows: () => (++lists === 1 ? { windows: [document, other] } : afterBind),
      verify_state: { status },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const out = yield* host.invoke(
      { ...call("wait_for", { window: "gone", timeoutMs: 0 }, ref), deadlineMillis },
      context,
    );
    return { out, listed: sent.filter((entry) => entry.tool === "list_windows").length };
  });

it.effect(
  "a gone window is confirmed only when a complete enumeration's authoritative ids omit it",
  () =>
    Effect.gen(function* () {
      const { out } = yield* waitGone("satisfied", {
        windows: [other],
        enumeration_complete: true,
        authoritative_window_ids: [9],
      });
      expect(out.category).toBe("confirmed");
      expect(out.value).toEqual({ met: true, status: "satisfied", closure: "closed" });
    }),
);

it.effect(
  "the driver's satisfied gone check is not met when an old driver, a contradiction or a failed listing leaves the closure unproven",
  () =>
    Effect.gen(function* () {
      for (const afterBind of [
        { windows: [other] },
        { windows: [other], enumeration_complete: false, authoritative_window_ids: [9] },
        { windows: [document], enumeration_complete: true, authoritative_window_ids: [9] },
        new DriverError({ code: "enumerator_failed" }, "CGWindowList failed"),
      ]) {
        const { out } = yield* waitGone("satisfied", afterBind);
        expect(out.category).toBe("unverifiable");
        expect(out.value).toEqual({ met: false, status: "satisfied", closure: "unproven" });
      }
      const present = yield* waitGone("satisfied", {
        windows: [other],
        enumeration_complete: true,
        authoritative_window_ids: [7, 9],
      });
      expect(present.out.value).toEqual({ met: false, status: "satisfied", closure: "present" });
    }),
);

it.effect("an unsatisfied gone check, or one with no time left in the cell, lists no windows", () =>
  Effect.gen(function* () {
    const unsatisfied = yield* waitGone("unsatisfied", { windows: [document] });
    expect(unsatisfied.out.value).toEqual({ met: false, status: "unsatisfied" });
    expect(unsatisfied.listed).toBe(1);
    const late = yield* waitGone("satisfied", { windows: [] }, 1_600);
    expect(late.out.category).toBe("unverifiable");
    expect(late.out.value).toEqual({ met: false, status: "satisfied", closure: "unproven" });
    expect(late.listed).toBe(1);
  }),
);

it.effect(
  "a key press after which complete ids omit the bound window reports it closed and keeps the driver's verdict",
  () =>
    Effect.gen(function* () {
      let pressed = false;
      const { host } = fixture({
        list_windows: () =>
          pressed
            ? { windows: [other], enumeration_complete: true, authoritative_window_ids: [9] }
            : { windows: [document, other] },
        press_key: () => {
          pressed = true;
          return { effect: "unverifiable" };
        },
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      yield* host.observe(call("get_window_state", {}, ref), context);
      const out = yield* host.invoke(
        { ...call("press_key", { key: "w", modifiers: ["cmd"] }, ref), deadlineMillis: 10_000 },
        context,
      );
      expect(out.category).toBe("unverifiable");
      expect(out.evidence).toContain("observed:window_closed");
      expect((out.value as { windows?: { bound?: string } }).windows?.bound).toBe("closed");
    }),
);
