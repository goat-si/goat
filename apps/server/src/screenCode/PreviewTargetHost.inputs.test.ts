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

it.effect(
  "a tab hover reaches the browser with its target and a 5 s wait, and retires the screenshot's points",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      expect((yield* fixture.dispatch("hover", { ref }))?.outcome).toBe("ok");
      expect(fixture.requests.find((request) => request.operation === "hover")?.input).toEqual({
        locator: "aria-ref=e1",
        timeoutMs: 5_000,
      });
      const refused = yield* fixture.dispatch("hover", { ref, timeoutMs: -5 });
      expect(refused?.error).toMatchObject({ code: "invalid_argument", effectStarted: false });
    }),
);

it.effect("an observed slider takes setValue by its number, while a button still does not", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    fixture.state.tree = "- slider Volume [ref=e3]\n- button Save [ref=e1]";
    const elements = (yield* fixture.observe()).elements;
    const slider = elements.find((element) => element.role === "slider")!.ref;
    const button = elements.find((element) => element.role === "button")!.ref;
    expect((yield* fixture.dispatch("set_value", { ref: slider, text: "70" }))?.outcome).toBe("ok");
    expect(
      (yield* fixture.dispatch("set_value", { ref: button, text: "70" }))?.error,
    ).toMatchObject({
      code: "unsupported",
      effectStarted: false,
    });
  }),
);

it.effect(
  "a click asked to wait 20 s for its target keeps the browser request open that long",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      yield* fixture.bridge.handle(
        {
          ...call("click", 901, { ref, timeoutMs: 20_000 }, fixture.ref),
          cellId: "long",
          deadlineMillis: 30_000,
        },
        { ...context, cellId: "long", limits: { ...context.limits, cellWallMs: 30_000 } },
      );
      const click = fixture.requests.find((request) => request.operation === "click");
      expect((click?.input as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(20_000);
      expect(click?.timeoutMs).toBeGreaterThanOrEqual(20_500);
    }),
);
