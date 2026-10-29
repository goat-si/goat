import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { browserFixture, call, context } from "./PreviewTargetHost.testkit.ts";

it.effect(
  "a tab wait carries enabled, value, checked, selected and state to the browser, false and empty included",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      yield* fixture.dispatch("wait_for", {
        ref,
        enabled: false,
        value: "",
        checked: true,
        selected: false,
        state: "visible",
        timeoutMs: 100,
      });
      const wait = fixture.requests.find((request) => request.operation === "waitFor");
      expect(wait?.input).toMatchObject({
        locator: "aria-ref=e1",
        enabled: false,
        value: "",
        checked: true,
        selected: false,
        state: "visible",
      });
    }),
);

it.effect("open and navigate refuse non-web URLs before the browser and pass web ones on", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    const browserCalls = () =>
      fixture.requests.filter(
        (request) => request.operation === "open" || request.operation === "navigate",
      ).length;
    for (const url of [
      "file:///Users/me/cu_lab.html",
      "  file:///Users/me/cu_lab.html",
      "data:text/html,<b>x</b>",
      "javascript:alert(1)",
      "javascript:123",
      "data:123",
      "tel:123",
      "about:blank",
    ]) {
      for (const method of ["open_tab", "navigate_tab"] as const) {
        const reply = yield* fixture.dispatch(method, { url });
        expect(reply?.error).toMatchObject({
          code: "unsupported",
          effectStarted: false,
          nextStep: "Browser tabs only open http(s) URLs; serve local files over http://127.0.0.1.",
        });
      }
    }
    expect(browserCalls()).toBe(0);
    for (const url of [
      "https://example.test/",
      "example.com",
      "localhost:3000",
      "example.com:8080/x",
    ])
      yield* fixture.dispatch("navigate_tab", { url });
    expect(
      fixture.requests
        .filter((request) => request.operation === "navigate")
        .map((request) => request.input),
    ).toEqual([
      { url: "https://example.test/" },
      { url: "example.com" },
      { url: "localhost:3000" },
      { url: "example.com:8080/x" },
    ]);
  }),
);

it.effect(
  "a tab click waits at most 5 s for its target by default, never past the cell, and is refused unsent when the cell is spent",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      const timeouts = () =>
        fixture.requests
          .filter((request) => request.operation === "click")
          .map((request) => (request.input as { timeoutMs?: number }).timeoutMs);
      yield* fixture.dispatch("click", { ref });
      yield* fixture.dispatch("click", { ref, timeoutMs: 800 });
      yield* fixture.dispatch("click", { ref, timeoutMs: 60_000 });
      // The testkit's cell ends at 10 s; 500 ms stay for the browser's answer.
      expect(timeouts()).toEqual([5_000, 800, 9_500]);
      for (const timeoutMs of [0, -1, 1.5, "5000"]) {
        const refused = yield* fixture.dispatch("click", { ref, timeoutMs });
        expect(refused?.error).toMatchObject({ code: "invalid_argument", effectStarted: false });
      }
      const spent = yield* fixture.bridge.handle(
        { ...call("click", 900, { ref }, fixture.ref), cellId: "spent", deadlineMillis: 700 },
        { ...context, cellId: "spent" },
      );
      expect(spent?.error).toMatchObject({ code: "deadline", effectStarted: false });
      expect(timeouts()).toHaveLength(3);
    }),
);

it.effect(
  "a range setValue the browser read back is a confirmed receipt; any other answer stays unverifiable",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const receipts = () =>
        fixture.bridge
          .takeCellImagesNow("run", "turn", "cell")
          .journal.filter((entry) => ["set_value", "type_text"].includes(entry.receipt.method))
          .map((entry) => entry.receipt.category);
      fixture.state.clickResult = { value: "70", effect: "confirmed", evidence: ["value"] };
      yield* fixture.dispatch("set_value", { selector: "#rng", text: "70" });
      // Typing is never confirmed by the browser's word alone.
      yield* fixture.dispatch("type_text", { selector: "#rng", text: "70" });
      fixture.state.clickResult = { value: "50", effect: "unverifiable", evidence: [] };
      yield* fixture.dispatch("set_value", { selector: "#rng", text: "70" });
      expect(receipts()).toEqual(["confirmed", "unverifiable", "unverifiable"]);
    }),
);
