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
