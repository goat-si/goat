import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenObservation, ScreenRunResult, ScreenTargetRef } from "@goat/contracts";
import {
  call,
  context,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const evCall = (...args: Parameters<typeof call>) => ({ ...call(...args), deadlineMillis: 10000 });

const win = (windowId: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  pid: 42,
  window_id: windowId,
  app_name: "Editor",
  title: "Document",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  is_on_screen: true,
  on_current_space: true,
  ...extra,
});

const verifyOutcome = (
  index: number,
  observed: Record<string, unknown> | undefined,
  status = "satisfied",
) => ({
  index,
  status,
  ...(observed === undefined ? {} : { observed_json: JSON.stringify(observed) }),
});

const cellService = (
  host: ReturnType<typeof fixture>["host"],
  scheduleDeadline?: (run: () => void, ms: number) => () => void,
) =>
  ScreenRunService.layerWithRuntime({
    dispatcher: createScreenDispatchRouter({ app: host }),
    desktopHost: host,
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
    ...(scheduleDeadline === undefined ? {} : { scheduleDeadline }),
  }).pipe(Layer.provide(NodeServices.layer));

const runCell = (source: string, limits?: Partial<typeof context.limits>) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    return yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source,
      ...(limits === undefined ? {} : { limits }),
    });
  });

it.effect(
  "T40/T40c/T40d/T40e/T40f: window absence and offscreen transitions report observed evidence without confirming on goat.8",
  () =>
    Effect.gen(function* () {
      let phase = 0;
      const { host } = fixture({
        list_windows: () => {
          phase++;
          if (phase <= 2) return { windows: [win(7), win(8, { title: "Palette" })] };
          return { windows: [win(8, { title: "Palette" })] };
        },
        press_key: { effect: "unverifiable" },
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const closedWithWitness = yield* host.invoke(
        evCall("press_key", { key: "w", modifiers: ["command"] }, ref),
        context,
      );
      expect(closedWithWitness.category).toBe("unverifiable");
      expect(closedWithWitness.evidence).toContain("observed:window_not_listed");
      expect((closedWithWitness.value as { windows?: { bound?: string } })?.windows?.bound).toBe(
        "not_listed",
      );

      let fPhase = 0;
      const filteredHost = fixture({
        list_windows: () => {
          fPhase++;
          if (fPhase <= 2)
            return {
              windows: [win(7, { title: "", on_current_space: null }), win(8, { title: "Main" })],
            };
          return { windows: [win(8, { title: "Main" })] };
        },
        click: { effect: "unverifiable" },
      }).host;
      const fBound = yield* filteredHost.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const fRes = yield* filteredHost.invoke(
        evCall("click", { x: 10, y: 10 }, fBound.value as ScreenTargetRef),
        context,
      );
      expect(fRes.category).toBe("unverifiable");
      expect(fRes.evidence).toContain("observed:window_not_listed");
      expect((fRes.value as { windows?: { bound?: string } })?.windows?.bound).toBe("not_listed");

      let uPhase = 0;
      const unverifiedHost = fixture({
        list_windows: () => {
          uPhase++;
          return uPhase <= 2 ? { windows: [win(7)] } : { windows: [] };
        },
        press_key: { effect: "unverifiable" },
      }).host;
      const uBound = yield* unverifiedHost.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const uRes = yield* unverifiedHost.invoke(
        evCall("press_key", { key: "w", modifiers: ["command"] }, uBound.value as ScreenTargetRef),
        context,
      );
      expect(uRes.category).toBe("unverifiable");
      expect(uRes.evidence).toContain("observed:window_list_unverified");
      expect((uRes.value as { windows?: { bound?: string } })?.windows?.bound).toBe("unverified");

      let oPhase = 0;
      const offHost = fixture({
        list_windows: () => {
          oPhase++;
          return oPhase <= 2
            ? { windows: [win(7), win(8)] }
            : { windows: [win(7, { is_on_screen: false, on_current_space: false }), win(8)] };
        },
        click: { effect: "unverifiable" },
      }).host;
      const oBound = yield* offHost.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const oRes = yield* offHost.invoke(
        evCall("click", { x: 10, y: 10 }, oBound.value as ScreenTargetRef),
        context,
      );
      expect(oRes.category).toBe("unverifiable");
      expect(oRes.evidence).toContain("observed:window_offscreen:on_current_space=false");
      expect((oRes.value as { windows?: { bound?: string } })?.windows?.bound).toBe("offscreen");
    }),
);

it.effect(
  "T41/T41c: acted element state change is observed only for unique non-lifted driver labels, and never confirms",
  () =>
    Effect.gen(function* () {
      let vCalls = 0;
      const { host } = fixture({
        get_window_state: {
          pid: 42,
          window_id: 7,
          tree_markdown: [
            '- [0] AXWindow "Doc"',
            '  - [1] AXCheckBox "Bold" = "0" [actions=[press]]',
            "  - [2] AXRow [actions=[press]]",
            '    - AXStaticText = "Italic"',
            '  - [3] AXRow "Italic" = "0" [actions=[press]]',
          ].join("\n"),
          elements_complete: false,
          elements: [
            { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "Doc" },
            {
              role: "AXCheckBox",
              element_index: 1,
              element_token: "s1:1",
              label: "Bold",
              value: "0",
              selected: false,
              actions: ["AXPress"],
            },
            {
              role: "AXRow",
              element_index: 2,
              element_token: "s1:2",
              actions: ["AXPress"],
            },
            {
              role: "AXRow",
              element_index: 3,
              element_token: "s1:3",
              label: "Italic",
              value: "0",
              actions: ["AXPress"],
            },
          ],
        },
        verify_state: () => {
          vCalls++;
          return {
            status: "satisfied",
            predicates: [
              verifyOutcome(
                0,
                vCalls === 1
                  ? { role: "AXCheckBox", label: "Bold", value: "0", selected: false }
                  : { role: "AXCheckBox", label: "Bold", value: "1", selected: true },
              ),
            ],
          };
        },
        click: { effect: "unverifiable" },
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const obs = (yield* host.observe(call("get_window_state", {}, ref), context))
        .value as ScreenObservation;
      const bold = obs.elements.find((e) => e.index === 1);
      const liftedRow = obs.elements.find((e) => e.index === 2);
      if (!bold || !liftedRow) throw new Error("Missing elements");

      const clickedBold = yield* host.invoke(
        evCall("click", { elementRef: bold.ref }, ref),
        context,
      );
      expect(clickedBold.category).toBe("unverifiable");
      expect(clickedBold.evidence).toContain('observed:element_state:value "0"→"1"');

      const clickedLifted = yield* host.invoke(
        evCall("click", { elementRef: liftedRow.ref }, ref),
        context,
      );
      expect(
        (clickedLifted.evidence ?? []).some((e) => e.startsWith("observed:element_state")),
      ).toBe(false);

      let mCalls = 0;
      const { host: mismatchHost } = fixture({
        get_window_state: {
          pid: 42,
          window_id: 7,
          tree_markdown: ['- [0] AXWindow "Doc"', '  - [1] AXTextField "Search" = "old"'].join(
            "\n",
          ),
          elements_complete: false,
          elements: [
            { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "Doc" },
            {
              role: "AXTextField",
              element_index: 1,
              element_token: "s1:1",
              label: "Search",
              value: "old",
            },
          ],
        },
        verify_state: () => {
          mCalls++;
          return {
            status: "satisfied",
            predicates: [
              verifyOutcome(
                0,
                mCalls === 1
                  ? { role: "AXTextField", label: "Search", value: "old", element_index: 1 }
                  : { role: "AXTextField", label: "Other", value: "Search 2", element_index: 2 },
              ),
            ],
          };
        },
        click: { effect: "unverifiable" },
      });
      const mBound = yield* mismatchHost.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const mRef = mBound.value as ScreenTargetRef;
      const mObs = (yield* mismatchHost.observe(call("get_window_state", {}, mRef), context))
        .value as ScreenObservation;
      const search = mObs.elements.find((e) => e.index === 1);
      if (!search) throw new Error("Missing search field");
      const clickedSearch = yield* mismatchHost.invoke(
        evCall("click", { elementRef: search.ref }, mRef),
        context,
      );
      expect(
        (clickedSearch.evidence ?? []).some((e) => e.startsWith("observed:element_state")),
      ).toBe(false);
    }),
);

it.effect(
  "T42: watched window value, new window and title changes are reported as observed evidence only",
  () =>
    Effect.gen(function* () {
      let lCalls = 0;
      let vCalls = 0;
      const { host } = fixture({
        get_window_state: {
          pid: 42,
          window_id: 7,
          tree_markdown:
            '- [0] AXWindow "Appearance"\n  - [1] AXStaticText "Display" = "0"\n  - [2] AXButton "About" [actions=[press]]',
          elements_complete: false,
          elements: [
            { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "Appearance" },
            {
              role: "AXStaticText",
              element_index: 1,
              element_token: "s1:1",
              label: "Display",
              value: "0",
            },
            {
              role: "AXButton",
              element_index: 2,
              element_token: "s1:2",
              label: "About",
              actions: ["AXPress"],
            },
          ],
        },
        list_windows: () => {
          lCalls++;
          return lCalls <= 2
            ? { windows: [win(7, { title: "Appearance" })] }
            : {
                windows: [win(7, { title: "About" }), win(82871, { title: "Inspector" })],
              };
        },
        verify_state: () => {
          vCalls++;
          return {
            status: "satisfied",
            predicates: [
              verifyOutcome(
                0,
                vCalls === 1
                  ? { role: "AXStaticText", label: "Display", value: "0" }
                  : { role: "AXStaticText", label: "Display", value: "702" },
              ),
            ],
          };
        },
        click: { effect: "unverifiable" },
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const obs = (yield* host.observe(call("get_window_state", {}, ref), context))
        .value as ScreenObservation;
      const btn = obs.elements.find((e) => e.index === 2);
      if (!btn) throw new Error("Missing button");
      const res = yield* host.invoke(evCall("click", { elementRef: btn.ref }, ref), context);
      expect(res.category).toBe("unverifiable");
      expect(res.evidence).toContain('observed:window_change:Display "0"→"702"');
      expect(res.evidence).toContain("observed:window_opened:82871");
      expect(res.evidence).toContain('observed:window_title:"Appearance"→"About"');
    }),
);

it.effect("T43: evidence read errors never resend and never fail the input", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    const { host, sent } = fixture({
      list_windows: () => {
        listCalls++;
        if (listCalls === 1) return { windows: [win(7)] };
        return new DriverError({ status: "failed" }, "WindowServer error");
      },
      verify_state: new DriverError({ status: "failed" }, "verify error"),
      click: { effect: "unverifiable" },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const res = yield* host.invoke(evCall("click", { x: 10, y: 10 }, ref), context);
    expect(res.category).toBe("unverifiable");
    expect(sent.filter((s) => s.tool === "click")).toHaveLength(1);
    expect(sent.filter((s) => s.tool === "list_windows").length).toBeGreaterThanOrEqual(3);
  }),
);

it.live("T44: a run_steps batch makes no per-input verify_state call", () => {
  const { host, sent } = fixture({
    run_steps: (args: { steps: ReadonlyArray<unknown> }) => ({
      ok: true,
      total: args.steps.length,
      executed: args.steps.length,
      failed_step: null,
      steps: args.steps.map((_, index) => ({
        index,
        tool: "click",
        ok: true,
        effect: "unverifiable",
      })),
    }),
  });
  return Effect.gen(function* () {
    yield* runCell(
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); " +
        "await Promise.all([app.click('Apply'), app.click('Apply'), app.click('Apply')]);",
    );
    expect(sent.filter((s) => s.tool === "click")).toHaveLength(3);
    expect(sent.filter((s) => s.tool === "verify_state")).toHaveLength(0);
    expect(sent.filter((s) => s.tool === "list_windows").length).toBeGreaterThanOrEqual(2);
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "T45/T45b/T45c/T45e/T45f/T45g/T45h/T51: windows opened are reported on inputs and on cell results/errors within budget",
  () => {
    let mode: "normal" | "many" | "emptyStart" | "emptyEnd" | "exactFit" = "normal";
    let step = 0;
    const { host } = fixture({
      get_window_state: (args: Record<string, unknown>) => goat2WindowState(args),
      list_windows: () => {
        step++;
        if (mode === "emptyStart" && step === 2) return { windows: [] };
        if (mode === "emptyEnd" && step >= 3) return { windows: [] };
        if (mode === "many" && step >= 3) {
          return {
            windows: [
              win(7),
              ...Array.from({ length: 20 }, (_, i) =>
                win(8000 + i, { title: "Sheet-" + i + "-" + "x".repeat(90) }),
              ),
            ],
          };
        }
        return step <= 2
          ? { windows: [win(7)] }
          : { windows: [win(7), win(82779, { title: "Go to Folder" })] };
      },
      click: () =>
        mode === "exactFit"
          ? { effect: "unverifiable", pad: "p".repeat(430) }
          : { effect: "unverifiable" },
    });
    return Effect.gen(function* () {
      const failedCell = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "const c = await app.click([10, 10]); await app.menu([]); return c;",
      ).pipe(Effect.result);
      expect(failedCell._tag).toBe("Failure");
      if (failedCell._tag === "Failure") {
        expect(failedCell.failure.windowsOpened?.map((w) => w.window_id)).toEqual([82779]);
      }

      mode = "many";
      step = 0;
      const manyRes = (yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "const c = await app.click([10, 10]); return c.result.windows;",
      )) as ScreenRunResult;
      expect(manyRes.windowsOpened).toHaveLength(16);
      expect(manyRes.windowsOpenedTruncated).toBe(true);
      expect(manyRes.windowsOpened?.[0]?.title.length).toBeLessThanOrEqual(80);
      const inputWins = manyRes.value as { opened: Array<{ title: string }>; truncated?: boolean };
      expect(inputWins.opened).toHaveLength(8);
      expect(inputWins.truncated).toBe(true);

      step = 0;
      const smallBudget = (yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "const c = await app.click([10, 10]); return c.result;",
        { returnBytes: 900 },
      )) as ScreenRunResult;
      expect((smallBudget.value as { windowsTruncated?: boolean })?.windowsTruncated).toBe(true);
      expect((smallBudget.value as { windows?: unknown })?.windows).toBeUndefined();

      mode = "exactFit";
      step = 0;
      const exactBudget = (yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "const c = await app.click([10, 10]); return Boolean(c.result.pad);",
        { returnBytes: 540 },
      )) as ScreenRunResult;
      expect(exactBudget.value).toBe(true);
      expect(exactBudget.windowsOpened?.map((w) => w.window_id)).toEqual([82779]);

      mode = "emptyStart";
      step = 0;
      const unvStart = (yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "await app.click([10, 10]); return 1;",
      )) as ScreenRunResult;
      expect(unvStart.windowsOpenedUnverified).toBe(true);
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live(
  "waitFor supports {value}, {role, value}, and {role, name, value: ''} on the pinned goat.10 driver without label substring collisions",
  () => {
    const elements = [
      { role: "AXStaticText", label: "1702", value: "1702", display_only: true },
      { role: "AXStaticText", label: "702", value: "702", display_only: true },
      { role: "AXTextField", label: "Search", value: "hello", element_index: 1 },
    ];
    const { host, sent } = fixture({
      verify_state: (args: {
        expect: ReadonlyArray<{
          element?: { selector: { role?: string; label_contains?: string }; value_equals?: string };
        }>;
      }) => {
        const el = args.expect[0]?.element;
        const hasValue = Boolean(el?.value_equals && el.value_equals.trim().length > 0);
        if (!el || (!el.selector.role && !el.selector.label_contains && !hasValue))
          return { status: "unknown", stable: false };
        const matched = elements.filter(
          (item) =>
            (!el.selector.role || item.role === el.selector.role) &&
            (!el.selector.label_contains ||
              item.label.toLowerCase().includes(el.selector.label_contains.toLowerCase()) ||
              item.value.toLowerCase().includes(el.selector.label_contains.toLowerCase())),
        );
        if (el.value_equals !== undefined) {
          const fieldMatches = matched.filter((item) => item.value === el.value_equals);
          if (fieldMatches.length > 0) return { status: "satisfied", stable: true };
        }
        if (matched.length !== 1) return { status: "unknown", stable: false };
        if (el.value_equals !== undefined && matched[0]?.value !== el.value_equals)
          return { status: "unsatisfied", stable: false };
        return { status: "satisfied", stable: true };
      },
    });
    return Effect.gen(function* () {
      const ok = (yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "const v1 = await app.waitFor({value: '702'}); " +
          "const v2 = await app.waitFor({role: 'AXStaticText', value: '702'}); " +
          "const vField = await app.waitFor({role: 'AXTextField', value: 'hello'}); " +
          "const vEmpty = await app.waitFor({role: 'AXTextField', name: 'Search', value: ''}); " +
          "let bareEmptyErr = ''; try { await app.waitFor({value: ''}); } catch (e) { bareEmptyErr = e.code; } " +
          "let emptyErr = ''; try { await app.waitFor({}); } catch (e) { emptyErr = e.code; } " +
          "return { m1: v1.met, m2: v2.met, mField: vField.met, mEmpty: vEmpty.met, bareEmptyErr, emptyErr };",
      )) as ScreenRunResult;
      expect(ok.value).toEqual({
        m1: true,
        m2: true,
        mField: true,
        mEmpty: false,
        bareEmptyErr: "invalid_argument",
        emptyErr: "invalid_argument",
      });
      const verifies = sent.filter((s) => s.tool === "verify_state");
      expect(verifies).toHaveLength(4);
      expect(verifies[0]?.args).toMatchObject({
        expect: [{ element: { selector: {}, exists: true, value_equals: "702" } }],
      });
      expect(verifies[1]?.args).toMatchObject({
        expect: [
          { element: { selector: { role: "AXStaticText" }, exists: true, value_equals: "702" } },
        ],
      });
      expect(verifies[2]?.args).toMatchObject({
        expect: [
          { element: { selector: { role: "AXTextField" }, exists: true, value_equals: "hello" } },
        ],
      });
      expect(verifies[3]?.args).toMatchObject({
        expect: [
          {
            element: {
              selector: { role: "AXTextField", label_contains: "Search" },
              exists: true,
              value_equals: "",
            },
          },
        ],
      });
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live(
  "T63a: 60 ms post-input settle sleep observes delayed main-runloop updates onto Done.observed within guestDoneBytes budget",
  () =>
    Effect.gen(function* () {
      let inPostReads = false;
      let postReadsForClick = 0;
      let bigHit: unknown;
      const { host } = fixture({
        list_windows: { windows: [win(7, { bounds: { x: 0, y: 0, width: 674, height: 408 } })] },
        get_window_state: (args: Record<string, unknown>) => {
          if (args.include_accessibility_tree === false) {
            return goat2WindowState(args, {
              snapshot_id: "s1",
              window_bounds: { x: 0, y: 0, width: 674, height: 408 },
            });
          }
          return {
            pid: 42,
            window_id: 7,
            snapshot_id: "s1",
            elements_complete: false,
            tree_markdown: [
              '- [0] AXWindow "Calculator"',
              '  - AXStaticText = "5,335" (Edit field)',
              '  - [11] AXCheckBox "Secondary Functions" = "0" [id=Shift actions=[press]]',
            ].join("\n"),
            elements: [
              {
                role: "AXWindow",
                element_index: 0,
                element_token: "s1:0",
                label: "Calculator",
                frame: { x: 0, y: 0, w: 674, h: 408 },
              },
              {
                role: "AXCheckBox",
                element_index: 11,
                element_token: "s1:11",
                label: "Secondary Functions",
                value: "0",
                selected: false,
                actions: ["AXPress"],
              },
            ],
            window_bounds: { x: 0, y: 0, width: 674, height: 408 },
          };
        },
        click: () => {
          inPostReads = true;
          postReadsForClick = 0;
          return {
            effect: "unverifiable",
            ...(bigHit === undefined ? {} : { hit: bigHit }),
          };
        },
        verify_state: () => {
          const settledAfterRetry = inPostReads && ++postReadsForClick >= 2;
          if (settledAfterRetry) inPostReads = false;
          return {
            status: "satisfied",
            predicates: [
              verifyOutcome(
                0,
                settledAfterRetry
                  ? {
                      role: "AXCheckBox",
                      label: "Secondary Functions",
                      value: "1",
                      selected: true,
                      element_index: 18,
                    }
                  : {
                      role: "AXCheckBox",
                      label: "Secondary Functions",
                      value: "0",
                      selected: false,
                      element_index: 18,
                    },
              ),
            ],
          };
        },
      });

      // T63a (1) & (2): pixel click and element click observe the 40 ms delayed transition via the 60 ms post-input settle sleep,
      // even when dense-row index (11) differs from verify_state exhaustive-walk element_index (18).
      const res = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "globalThis.calcApp = app; await app.observe(); await app.screenshot(); " +
          "const pxDone = await app.click([20, 20]); " +
          "const elDone = await app.click(11); " +
          "return { pxObs: pxDone.observed, pxRawObs: pxDone.result?._observed, elObs: elDone.observed };",
      ).pipe(Effect.provide(cellService(host)));
      expect(res.value).toEqual({
        pxObs: ['observed:window_change:Secondary Functions "0"→"1"'],
        pxRawObs: undefined,
        elObs: ['observed:element_state:value "0"→"1"'],
      });

      // T63a (3): a >200-byte hit object near returnBytes is measured via guestDoneBytes so returning Done directly never exceeds returnBytes.
      bigHit = { role: "AXButton", label: "x".repeat(180), element_token: "s1:11" };
      const tightDone = yield* Effect.gen(function* () {
        yield* runCell(
          "globalThis.calcApp = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await calcApp.observe(); return 1;",
        );
        return yield* runCell("return await calcApp.click({ window: [50, 50] });", {
          returnBytes: 620,
        });
      }).pipe(Effect.provide(cellService(host)));
      expect(tightDone.status).toBe("completed");
    }),
);

it.effect(
  "T63b: tight-budget screenshot preserves needsSettleBeforeCapture until a screenshot with sufficient budget completes the 60 ms settle sleep",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_windows: { windows: [win(7, { bounds: { x: 0, y: 0, width: 674, height: 408 } })] },
        get_window_state: (args: Record<string, unknown>) =>
          goat2WindowState(args, {
            snapshot_id: "s1",
            window_bounds: { x: 0, y: 0, width: 674, height: 408 },
          }),
        click: { effect: "unverifiable" },
      });
      const bound = (yield* host.bindApp(
        evCall("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      )).value as ScreenTargetRef;
      yield* host.invoke(
        {
          ...call("click", { x: 10, y: 10, coordinate_space: "window_points" }, bound),
          deadlineMillis: 2_600,
        },
        context,
      );
      yield* host.observe(
        {
          ...call("screenshot", {}, bound),
          deadlineMillis: 8_510,
        },
        context,
      );
      const shotsBefore = sent.filter((s) => s.tool === "get_window_state").length;
      const settledFiber = yield* host
        .observe(
          {
            ...call("screenshot", {}, bound),
            deadlineMillis: 20_000,
          },
          context,
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(sent.filter((s) => s.tool === "get_window_state")).toHaveLength(shotsBefore);
      yield* TestClock.adjust("60 millis");
      yield* Fiber.join(settledFiber);
      expect(sent.filter((s) => s.tool === "get_window_state")).toHaveLength(shotsBefore + 1);
    }),
);
