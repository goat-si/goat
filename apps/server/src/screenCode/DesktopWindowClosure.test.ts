import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { waitForOutcome, windowClosure } from "./DesktopWindowClosure.ts";
import { diffInputWindows, parseWindowList } from "./DesktopWindows.ts";
import { terminalFailure } from "../cua/ComputerUseTerminal.ts";

it.effect.each(["stopped_by_person", "screen_locked"] as const)(
  "window closure keeps a terminal %s read failure",
  (reason) =>
    Effect.gen(function* () {
      const failure = terminalFailure({ reason, possibleCommit: false }, "list_windows", {});
      if (failure === undefined) return yield* Effect.die("missing terminal failure");
      const result = yield* waitForOutcome({
        status: "satisfied",
        gone: true,
        list: () => Effect.fail(failure),
        target: { pid: 42, windowId: 7 },
        cellDeadlineMillis: 3000,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe(reason);
    }),
);

const listing = (windows: unknown, extra: Record<string, unknown> = {}) => ({ windows, ...extra });
const complete = (ids: unknown) => ({ enumeration_complete: true, authoritative_window_ids: ids });
const other = { pid: 42, window_id: 9, title: "Other" };

describe("windowClosure", () => {
  it("a complete enumeration without the window proves it closed, including when the process left none", () => {
    expect(windowClosure(listing([other], complete([9])), 42, 7)).toBe("closed");
    expect(windowClosure(listing([], complete([])), 42, 7)).toBe("closed");
  });

  it("a window in the authoritative ids is present even when the listing filtered it out", () => {
    expect(windowClosure(listing([other], complete([7, 9])), 42, 7)).toBe("present");
    expect(windowClosure(complete([7, 9]), 42, 7)).toBe("unproven");
    expect(windowClosure(listing([null], complete([7, 9])), 42, 7)).toBe("unproven");
  });

  it("an old driver, an incomplete enumeration or malformed ids prove nothing", () => {
    expect(windowClosure(listing([other]), 42, 7)).toBe("unproven");
    expect(
      windowClosure(
        listing([other], { enumeration_complete: false, authoritative_window_ids: [9] }),
        42,
        7,
      ),
    ).toBe("unproven");
    expect(windowClosure(listing([other], { enumeration_complete: true }), 42, 7)).toBe("unproven");
    for (const ids of [[9, 0], [9, -1], [9, 1.5], [9, "7"], "9", [Number.MAX_SAFE_INTEGER + 2]])
      expect(windowClosure(listing([other], complete(ids)), 42, 7)).toBe("unproven");
  });

  it("a listing that still shows the window while its ids omit it is a contradiction, not a closure", () => {
    expect(
      windowClosure(listing([{ pid: 42, window_id: 7, title: "Doc" }], complete([9])), 42, 7),
    ).toBe("unproven");
  });

  it("a missing or malformed listing could hide the window, so it proves nothing", () => {
    expect(windowClosure(complete([9]), 42, 7)).toBe("unproven");
    expect(windowClosure(listing("none", complete([9])), 42, 7)).toBe("unproven");
    for (const bad of [
      null,
      "7",
      { window_id: "7" },
      { window_id: 0 },
      { pid: "42", window_id: 7 },
    ])
      expect(windowClosure(listing([other, bad], complete([9])), 42, 7)).toBe("unproven");
    expect(windowClosure(undefined, 42, 7)).toBe("unproven");
    expect(windowClosure([], 42, 7)).toBe("unproven");
  });
});

it.effect(
  "a gone wait whose listing does not answer before the cell's reserve stays unproven",
  () =>
    Effect.gen(function* () {
      const fiber = yield* waitForOutcome({
        status: "satisfied",
        gone: true,
        list: () => Effect.never,
        target: { pid: 42, windowId: 7 },
        cellDeadlineMillis: 3_000,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1500 millis");
      expect(yield* Fiber.join(fiber)).toEqual({
        value: { met: false, status: "satisfied", closure: "unproven" },
        category: "unverifiable",
        evidence: ["verify_state:satisfied", "window_closure:unproven"],
      });
    }),
);

describe("diffInputWindows with closure ids", () => {
  const before = parseWindowList(listing([{ pid: 42, window_id: 7, title: "Doc" }, other]), 42);
  const diff = (after: Record<string, unknown>, from = before) =>
    diffInputWindows(from, parseWindowList(after, 42), 7, windowClosure(after, 42, 7));

  it("an input after which complete ids omit the bound window reports it closed", () => {
    const { report, evidence } = diff(listing([other], complete([9])));
    expect(report.bound).toBe("closed");
    expect(evidence).toContain("observed:window_closed");
    expect(evidence).not.toContain("observed:window_not_listed");
  });

  it("without proof, or without the window before the input, the old listing answer stands", () => {
    expect(diff(listing([other])).report.bound).toBe("not_listed");
    expect(diff(listing([other], complete([7, 9]))).report.bound).toBe("not_listed");
    expect(diff(listing([], complete([]))).report.bound).toBe("closed");
    const absentBefore = parseWindowList(listing([other]), 42);
    expect(diff(listing([other], complete([9])), absentBefore).report.bound).toBe("not_listed");
  });
});
