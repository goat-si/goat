import { expect, it } from "@effect/vitest";
import {
  PreviewAutomationTimeoutError,
  type ScreenHostCall,
  type ScreenObservation,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { actionErrorContext, browserFixture, call, context } from "./PreviewTargetHost.testkit.ts";

it.effect("a click the browser saw change something is a confirmed receipt", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    fixture.state.clickResult = { effect: "confirmed", evidence: ["dom"] };
    yield* fixture.dispatch("claim_tab");
    const ref = (yield* fixture.observe()).elements[0]!.ref;
    expect((yield* fixture.dispatch("click", { ref }))?.outcome).toBe("ok");
    fixture.state.clickResult = { effect: "suspected_noop", evidence: [] };
    expect((yield* fixture.dispatch("click", { ref }))?.outcome).toBe("ok");
    const { journal } = fixture.bridge.takeCellImagesNow("run", "turn", "cell");
    // Claiming is not input on the page: once settled, it carries no unknown axes.
    const claim = journal.find((entry) => entry.receipt.method === "claim_tab")?.receipt;
    expect(claim && "outcome" in claim).toBe(false);
    const receipts = journal
      .filter((entry) => entry.receipt.method === "click")
      .map((entry) => [entry.receipt.category, entry.receipt.evidence, entry.receipt.outcome]);
    // The input went out both times; only the first was seen to change the page.
    expect(receipts).toEqual([
      ["confirmed", ["click:dom"], { dispatch: "confirmed", effect: "confirmed" }],
      [
        "unverifiable",
        ["dispatched; observe to confirm"],
        { dispatch: "confirmed", effect: "unknown" },
      ],
    ]);
  }),
);

it.effect("the caller's own tab takes input without a claim, also after its control moved", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture(true);
    const ref = (yield* fixture.observe()).elements[0]!.ref;
    expect((yield* fixture.dispatch("click", { ref }))?.outcome).toBe("ok");
    // Taking control moved the generation; a new binding in a later cell still acts.
    fixture.state.generation += 1;
    fixture.tab.controlGeneration = 1;
    const targetRef = yield* fixture.rebind();
    const reply = yield* fixture.bridge.handle(
      {
        ...call("navigate_tab", 50, { url: "https://example.test/next" }, targetRef),
        cellId: "later",
      },
      { ...context, cellId: "later" },
    );
    expect(reply?.outcome).toBe("ok");
  }),
);

it.effect(
  "a click whose reply was lost is settled by observing in the same cell, never by a second click",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      fixture.state.lostReply = new PreviewAutomationTimeoutError(actionErrorContext);
      const inCell = (
        method: ScreenHostCall["method"],
        callId: number,
        args: ScreenHostCall["args"],
      ) =>
        fixture.bridge.handle(
          { ...call(method, callId, args, fixture.ref), cellId: "lost" },
          { ...context, cellId: "lost" },
        );
      expect((yield* inCell("click", 40, { ref }))?.error?.code).toBe("unknown_outcome");
      const after = yield* inCell("observe", 41, {});
      expect(after?.outcome).toBe("ok");
      expect((after?.value as ScreenObservation | undefined)?.indexedText).toContain("Cancel");
      expect((yield* inCell("click", 42, { ref }))?.error?.code).toBe("not_run");
      expect(fixture.requests.filter((request) => request.operation === "click")).toHaveLength(1);
    }),
);

it.effect(
  "a navigation that reached its page is a confirmed receipt; one without a URL is not",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      fixture.state.clickResult = { url: "https://example.test/next" };
      expect(
        (yield* fixture.dispatch("navigate_tab", { url: "https://example.test/next" }))?.outcome,
      ).toBe("ok");
      fixture.state.clickResult = {};
      expect(
        (yield* fixture.dispatch("navigate_tab", { url: "https://example.test/other" }))?.outcome,
      ).toBe("ok");
      const receipts = fixture.bridge
        .takeCellImagesNow("run", "turn", "cell")
        .journal.filter((entry) => entry.receipt.method === "navigate_tab")
        .map((entry) => [entry.receipt.category, entry.receipt.evidence]);
      expect(receipts).toEqual([
        ["confirmed", ["navigate:reached", "origin:https://example.test"]],
        ["unverifiable", ["dispatched; observe to confirm"]],
      ]);
    }),
);

it.effect("typed text stays unverifiable, whatever the page answers about it", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    const ref = (yield* fixture.observe()).elements[0]!.ref;
    fixture.state.clickResult = { effect: "confirmed", evidence: ["value"] };
    expect((yield* fixture.dispatch("type_text", { ref, text: "Ada" }))?.outcome).toBe("ok");
    fixture.state.clickResult = { ok: true };
    expect((yield* fixture.dispatch("type_text", { ref, text: "Ada" }))?.outcome).toBe("ok");
    const receipts = fixture.bridge
      .takeCellImagesNow("run", "turn", "cell")
      .journal.filter((entry) => entry.receipt.method === "type_text")
      .map((entry) => [entry.receipt.category, entry.receipt.evidence]);
    expect(receipts).toEqual([
      ["unverifiable", ["dispatched; observe to confirm"]],
      ["unverifiable", ["dispatched; observe to confirm"]],
    ]);
  }),
);

it.effect(
  "a tab click count of 2 or 3 reaches the browser as its click count; any other count sends nothing",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      const clicks = () => fixture.requests.filter((request) => request.operation === "click");
      expect((yield* fixture.dispatch("click", { ref, count: 2 }))?.outcome).toBe("ok");
      expect((yield* fixture.dispatch("right_click", { ref, count: 3 }))?.outcome).toBe("ok");
      expect(clicks().map((request) => request.input)).toMatchObject([
        { clickCount: 2 },
        { clickCount: 3, button: "right" },
      ]);
      for (const count of [0, 4, 1.5, "2"]) {
        const refused = yield* fixture.dispatch("click", { ref, count });
        expect(refused?.error).toMatchObject({ code: "invalid_argument", effectStarted: false });
      }
      expect(clicks()).toHaveLength(2);
    }),
);

it.effect(
  "a tab input's result carries its host time, also when the browser answered nothing",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      const timing = { ms: 0, phases: { driverMs: 0 } };
      expect((yield* fixture.dispatch("click", { ref }))?.value).toEqual({
        ok: true,
        _timing: timing,
      });
      fixture.state.clickResult = undefined as never;
      expect((yield* fixture.dispatch("press_key", { key: "Escape" }))?.value).toEqual({
        _timing: timing,
        _noResult: true,
      });
      fixture.state.clickResult = {};
      expect((yield* fixture.dispatch("press_key", { key: "Escape" }))?.value).toEqual({
        _timing: timing,
      });
    }),
);
