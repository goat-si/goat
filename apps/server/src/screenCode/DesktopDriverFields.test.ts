import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { context, DriverSuccess, fixture } from "./DesktopTargetHost.testkit.ts";
import { annotatePointerResult } from "./DesktopTargetPoints.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const runCell = (host: ReturnType<typeof fixture>["host"], source: string) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
    const res = yield* service.runCell({ ...turn, invocation: context.invocation, source });
    yield* service.finishTurn({ ...turn, reason: "test" });
    return res;
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

const state = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s0000000a",
  elements_complete: false,
  tree_format: "both",
  tree_markdown: '[0] AXWindow "Editor"\n  [1] AXButton "Apply"',
  elements: [
    { element_index: 0, element_token: "s0000000a:0", role: "AXWindow", label: "Editor" },
    {
      element_index: 1,
      element_token: "s0000000a:1",
      role: "AXButton",
      label: "Apply",
      parent_index: 0,
    },
  ],
};

it.live.each([
  [
    { status: "abandoned", reason: "panic", prior_pid: 123 },
    "focus restoration failed (panic): the prior app (pid 123) may not have been restored",
  ],
  [
    { status: "abandoned", reason: "unconfirmed", prior_pid: 123 },
    "focus restoration unconfirmed: the prior app (pid 123) may not be in front",
  ],
  [
    { status: "abandoned", reason: "user_input", prior_pid: 123 },
    "focus restoration abandoned: user_input (prior app pid 123)",
  ],
  [{ status: "restored", prior_pid: 123 }, "focus restored to the prior app (pid 123)"],
])("text-only focus restoration reaches input and observation warnings: %s", ([focus, warning]) =>
  Effect.gen(function* () {
    const blocks = ["Action completed.", `focus_restoration: ${JSON.stringify(focus)}`];
    const { host } = fixture({
      get_window_state: new DriverSuccess(state, blocks),
      click: new DriverSuccess({ effect: "unverifiable", summary: "Action completed." }, blocks),
    });
    const result = yield* runCell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
        "const observation = await app.observe(); const done = await app.click(1); " +
        "return { observation: observation.warnings, done };",
    );
    expect(result.value).toEqual({
      observation: [warning],
      done: { ok: true, verdict: "unverifiable", warnings: [warning] },
    });
  }),
);

it.live("app clicks return a compact Done and expose details only on request", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      list_windows: { windows: [{ pid: 42, window_id: 7, title: "Document" }] },
      get_window_state: state,
      click: {
        effect: "confirmed",
        evidence: ["driver:acted"],
        point: { x: 2, y: 3, coordinate_space: "window_points" },
      },
    });
    const res = yield* runCell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); " +
        "const plain = await app.click(1); const batch = await Promise.all([app.click(1), app.click(1)]); const verified = await app.click(1, {verify: true}); " +
        "screen.debug = true; const debug = await app.click(1); return {plain, batch, verified, debug};",
    );
    expect(res.value).toMatchObject({
      plain: { ok: true, verdict: "confirmed" },
      batch: [
        { ok: true, verdict: "confirmed" },
        { ok: true, verdict: "confirmed" },
      ],
      verified: {
        result: { debug: { evidence: expect.arrayContaining(["driver:effect=confirmed"]) } },
      },
      debug: { result: { debug: expect.any(Object) } },
    });
    const value = res.value as { plain: unknown };
    expect(value.plain).toEqual({ ok: true, verdict: "confirmed" });
    expect(Buffer.byteLength(JSON.stringify(value.plain))).toBeLessThanOrEqual(200);
  }),
);

it.live.each([
  {
    tool: "click",
    reply: { effect: "suspected_noop" },
    source: "app.click(1)",
    expected: { ok: true, verdict: "suspected_noop" },
  },
  {
    tool: "click",
    reply: {
      effect: "confirmed",
      focus_restoration: { status: "abandoned", reason: "user_input", prior_pid: 123 },
    },
    source: "app.click(1)",
    expected: {
      ok: true,
      verdict: "confirmed",
      warnings: ["focus restoration abandoned: user_input (prior app pid 123)"],
    },
  },
  {
    tool: "press_key",
    reply: new DriverSuccess(
      { effect: "unverifiable", code: "ax_action_unverified" },
      "Sent AXPress to Edit > Undo for window 7; the requested chord was not sent as keys. Its effect is unverified. The item read disabled before the press.",
    ),
    source: "app.press('cmd+z')",
    expected: {
      ok: true,
      verdict: "unverifiable",
      warnings: ["The item read disabled before the press."],
    },
  },
  {
    tool: "click",
    reply: {
      effect: "confirmed",
      focus_restoration: { status: "restored", prior_pid: 123 },
      note: "note text",
      warning: "warning text",
    },
    source: "app.click(1)",
    expected: {
      ok: true,
      verdict: "confirmed",
      warnings: ["focus restored to the prior app (pid 123)", "note text", "warning text"],
    },
  },
  {
    tool: "press_key",
    reply: new DriverSuccess(
      { effect: "suspected_noop" },
      "Keys were sent. The item read disabled after validation.",
    ),
    source: "app.press('cmd+z')",
    expected: {
      ok: true,
      verdict: "suspected_noop",
      warnings: ["The item read disabled after validation."],
    },
  },
  {
    tool: "click",
    reply: { effect: "confirmed", warning: "x".repeat(250) },
    source: "app.click(1)",
    expected: { ok: true, verdict: "confirmed", warnings: ["x".repeat(200)] },
  },
  {
    tool: "click",
    reply: { effect: "confirmed" },
    source: "app.click(1)",
    expected: { ok: true, verdict: "confirmed" },
  },
])("input $tool preserves $expected.verdict and warnings without debug", (entry) =>
  Effect.gen(function* () {
    const { host } = fixture({ get_window_state: state, [entry.tool]: entry.reply });
    const res = yield* runCell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); return await " +
        entry.source +
        ";",
    );
    expect(res.value).toEqual(entry.expected);
  }),
);

it.live.each([
  {
    reason: "panic",
    warning: "focus restoration failed (panic): the prior app (pid 123) may not have been restored",
  },
  {
    reason: "unconfirmed",
    warning: "focus restoration unconfirmed: the prior app (pid 123) may not be in front",
  },
])(
  "a focus restoration $reason warns on the next app observation without debug",
  ({ reason, warning }) =>
    Effect.gen(function* () {
      const { host } = fixture({
        get_window_state: new DriverSuccess(
          { ...state, focus_restoration: { status: "abandoned", reason, prior_pid: 123 } },
          `focus_restoration: {"status":"abandoned","reason":"${reason}","prior_pid":123}`,
        ),
        click: new DriverSuccess(
          {
            effect: "confirmed",
            focus_restoration: { status: "abandoned", reason, prior_pid: 123 },
          },
          `focus_restoration: {"status":"abandoned","reason":"${reason}","prior_pid":123}`,
        ),
      });
      const result = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "const observation = await app.observe(); const done = await app.click(1); " +
          "return { observation: observation.warnings, done };",
      );
      expect(result.value).toEqual({
        observation: [warning],
        done: { ok: true, verdict: "confirmed", warnings: [warning] },
      });
    }),
);

it.live.each([
  { note: "first notice", warning: "second warning", expected: ["first notice", "second warning"] },
  { note: "same notice", warning: "  same   notice ", expected: ["same notice"] },
])(
  "observations expose distinct structured warnings without debug",
  ({ note, warning, expected }) =>
    Effect.gen(function* () {
      const { host } = fixture({ get_window_state: { ...state, note, warning } });
      const result = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); return (await app.observe()).warnings;",
      );
      expect(result.value).toEqual(expected);
    }),
);

it.live("an input deduplicates a disabled read sentence repeated as a structured note", () =>
  Effect.gen(function* () {
    const note = "The item read disabled before the press.";
    const { host } = fixture({
      get_window_state: state,
      press_key: new DriverSuccess(
        { effect: "unverifiable", code: "ax_action_unverified", note },
        `Sent AXPress to Edit > Undo for window 7; the requested chord was not sent as keys. Its effect is unverified. ${note}`,
      ),
    });
    const result = yield* runCell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); return await app.press('cmd+z');",
    );
    expect(result.value).toEqual({ ok: true, verdict: "unverifiable", warnings: [note] });
  }),
);

it.live("an input deduplicates identical structured notes and warnings", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      get_window_state: state,
      click: { effect: "confirmed", note: "same notice", warning: "  same   notice " },
    });
    const result = yield* runCell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); return await app.click(1);",
    );
    expect(result.value).toEqual({ ok: true, verdict: "confirmed", warnings: ["same notice"] });
  }),
);

it.live("a window read never turns input-only driver text into a warning", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      get_window_state: new DriverSuccess(
        state,
        "Window 7. Its effect is unverified. The item read disabled before the press.",
      ),
    });
    const result = yield* runCell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
        "const observation = await app.observe(); return { hasWarnings: 'warnings' in observation };",
    );
    expect(result.value).toEqual({ hasWarnings: false });
  }),
);

it.live("a routine app observation has no warnings", () =>
  Effect.gen(function* () {
    const { host } = fixture({ get_window_state: state });
    const result = yield* runCell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
        "const observation = await app.observe(); return { hasWarnings: 'warnings' in observation };",
    );
    expect(result.value).toEqual({ hasWarnings: false });
  }),
);

// A cell runs in a child process, so this test runs on the wall clock.
it.live(
  "a goat.12 click reply and a list_windows reply with closure ids reach the guest, which sees point and hit in GOAT's terms",
  () =>
    Effect.gen(function* () {
      const { host } = fixture({
        list_windows: {
          windows: [{ pid: 42, window_id: 7, title: "Document" }],
          enumeration_complete: true,
          authoritative_window_ids: [7, 9],
        },
        get_window_state: state,
        click: {
          effect: "confirmed",
          evidence: ["driver:acted"],
          point: { x: 180, y: 75, coordinate_space: "window_points" },
          hit: { role: "AXButton", label: "Apply", identifier: "apply-button" },
        },
      });
      const res = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "await app.observe(); screen.debug = true; const done = await app.click(1); " +
          "return { verdict: done.verdict, point: done.result.debug.value.point, hit: done.result.debug.value.hit, resultPoint: done.result.debug.value.point };",
      );
      expect(res.value).toEqual({
        verdict: "confirmed",
        point: { x: 180, y: 75, unit: "window_points" },
        hit: { role: "AXButton", name: "Apply", id: "apply-button" },
        resultPoint: { x: 180, y: 75, unit: "window_points" },
      });
    }),
);

// A cell runs in a child process, so this test runs on the wall clock.
it.live(
  "a guest waitFor({window:'gone'}) is met, and its receipt confirmed, only when the driver's authoritative ids omit the window",
  () =>
    Effect.gen(function* () {
      const document = { pid: 42, window_id: 7, title: "Document" };
      const waitGone = (afterVerify: Record<string, unknown>) =>
        Effect.gen(function* () {
          let verified = false;
          const { host } = fixture({
            list_windows: () => (verified ? afterVerify : { windows: [document] }),
            verify_state: () => {
              verified = true;
              return { status: "satisfied" };
            },
          });
          const res = yield* runCell(
            host,
            "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
              "return await app.waitFor({ window: 'gone' }, 0);",
          );
          const receipt = res.journal.find((entry) => entry.receipt.method === "wait_for");
          return { value: res.value, category: receipt?.receipt.category };
        });
      expect(
        yield* waitGone({ windows: [], enumeration_complete: true, authoritative_window_ids: [] }),
      ).toEqual({
        value: { met: true, status: "satisfied", closure: "closed" },
        category: "confirmed",
      });
      expect(yield* waitGone({ windows: [] })).toEqual({
        value: { met: false, status: "satisfied", closure: "unproven" },
        category: "unverifiable",
      });
    }),
);

describe("annotatePointerResult", () => {
  const done = (value: unknown) => ({ category: "confirmed" as const, value });
  const at = { x: 80, y: 75 };

  it("a pointer reply with neither point nor hit reports GOAT's window point, or none, and hit null", () => {
    expect(annotatePointerResult(done({ effect: "confirmed" }), at, "click").value).toEqual({
      effect: "confirmed",
      point: { x: 80, y: 75, unit: "window_points" },
      hit: null,
    });
    expect(annotatePointerResult(done({ effect: "confirmed" }), undefined, "click").value).toEqual({
      effect: "confirmed",
      hit: null,
    });
  });

  it("a non-pointer reply comes back unchanged, whether or not the call site says so", () => {
    const typed = done({ effect: "confirmed", typed: "hello" });
    expect(annotatePointerResult(typed, undefined)).toBe(typed);
    expect(annotatePointerResult(typed, undefined, "type_text")).toBe(typed);
    const odd = done({ point: { x: 1, y: 2, coordinate_space: "window_points" } });
    expect(annotatePointerResult(odd, at, "type_text")).toBe(odd);
  });

  it("a driver point in another or an unnamed space is replaced by GOAT's window point, or left out", () => {
    for (const point of [
      { x: 900, y: 700, coordinate_space: "screen_points" },
      { x: 900, y: 700 },
      { x: Number.NaN, y: 1, coordinate_space: "window_points" },
      "900,700",
    ]) {
      expect(annotatePointerResult(done({ point }), at).value).toEqual({
        point: { x: 80, y: 75, unit: "window_points" },
        hit: null,
      });
      expect(annotatePointerResult(done({ point }), undefined).value).toEqual({ hit: null });
    }
    expect(
      annotatePointerResult(done({ point: { x: 3, y: 4, unit: "window_points" } }), undefined)
        .value,
    ).toEqual({ point: { x: 3, y: 4, unit: "window_points" }, hit: null });
  });

  it("a driver hit keeps only role, name and id as strings, never its index, and an empty one is null", () => {
    const mapped = (hit: unknown) =>
      (annotatePointerResult(done({ hit }), at).value as { hit: unknown }).hit;
    expect(mapped({ index: 3, role: "AXButton", label: "OK", identifier: "ok" })).toEqual({
      role: "AXButton",
      name: "OK",
      id: "ok",
    });
    expect(mapped({ role: "push button", label: "OK" })).toEqual({
      role: "push button",
      name: "OK",
    });
    expect(mapped({ index: 3, label: "  ", role: 7 })).toBeNull();
    expect(mapped("OK")).toBeNull();
  });
});
