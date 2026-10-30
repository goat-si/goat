import * as Fiber from "effect/Fiber";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import { driverCallDeadline, MIN_CALL_MS } from "../cua/ComputerUseCallCaps.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
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

// Evidence is read around an input only when the call asks for it.
const evCall = (...[method, args, ref]: Parameters<typeof call>) => ({
  ...call(method, { ...(args as object), verify: true }, ref),
  deadlineMillis: 500000,
});

const invokeEv = (host: ReturnType<typeof fixture>["host"], c: ReturnType<typeof evCall>) =>
  Effect.gen(function* () {
    const fiber = yield* host.invoke(c, context).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("60 millis");
    return yield* Fiber.join(fiber);
  });

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

it.live(
  "T49/T49b/T49c/T49d/T49e: sheet rebinds to parent with a new generation, waitFor hidden checks offscreen, and click({action}) validates and forwards",
  () => {
    let shotWindow = 82779;
    const { host, sent } = fixture({
      list_windows: {
        windows: [
          win(72907, { title: "Recents" }),
          win(82779, { title: "Go to Folder", is_on_screen: false, on_current_space: true }),
        ],
      },
      get_window_state: (args: Record<string, unknown>) => {
        if (args.include_accessibility_tree === false) {
          return goat2WindowState(args, {
            window_id: shotWindow,
            snapshot_id: shotWindow === 82779 ? "s_sheet" : "s_parent",
          });
        }
        if (args.window_id === 82779) {
          return {
            pid: 42,
            window_id: 82779,
            degraded: true,
            degraded_reason: "window_is_sheet: window_id 82779 is a sheet attached to window 72907",
            sheet_of_window_id: 72907,
            next_call: {
              tool: "get_window_state",
              arguments: { pid: 42, window_id: 72907 },
            },
            elements_complete: false,
            tree_markdown: "",
            elements: [],
          };
        }
        shotWindow = 72907;
        return {
          pid: 42,
          window_id: 72907,
          snapshot_id: "s_parent",
          elements_complete: false,
          tree_markdown:
            '- [0] AXWindow "Recents"\n  - [1] AXSheet\n    - [2] AXButton "Go" [actions=[press,showmenu]]',
          elements: [
            { role: "AXWindow", element_index: 0, element_token: "sp:0", label: "Recents" },
            { role: "AXSheet", element_index: 1, element_token: "sp:1" },
            {
              role: "AXButton",
              element_index: 2,
              element_token: "sp:2",
              label: "Go",
              actions: ["AXPress", "AXShowMenu"],
            },
          ],
        };
      },
      click: { effect: "unverifiable" },
    });
    return Effect.gen(function* () {
      const res = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 82779}); " +
          "const oldGen = app.generation; const oldRef = app.targetRef; " +
          "await app.screenshot(); " +
          "const obs = await app.observe(); " +
          "const genMoved = app.generation > oldGen && app.targetRef.generation === obs.targetRef.generation && app.targetRef.id === oldRef.id; " +
          "const oldPointCode = await (async () => app.click([10, 10]))().then(() => 'ok', (e) => e.code); " +
          "const badAction = await (async () => app.click(2, {action: 'open'}))().then(() => 'ok', (e) => e.code); " +
          "await app.click(2, {action: 'show_menu'}); " +
          "await app.screenshot(); " +
          "await app.click([10, 10]); " +
          "const hiddenWait = await app.waitFor({window: 'hidden'}, 0); " +
          "return { genMoved, oldPointCode, badAction, buttons: obs.elements.length, hiddenMet: hiddenWait.met };",
      );
      expect(res.value).toMatchObject({
        genMoved: true,
        oldPointCode: "stale_reference",
        badAction: "invalid_argument",
        buttons: 3,
        hiddenMet: false,
      });
      const clicks = sent.filter((s) => s.tool === "click");
      expect(clicks).toHaveLength(2);
      expect(clicks[0]?.args).toMatchObject({
        element_token: "sp:2",
        action: "show_menu",
      });
      expect(clicks[1]?.args).toMatchObject({
        target: { kind: "window", pid: 42, window_id: 72907 },
        x: 5,
        y: 5,
      });

      const hiddenRes = yield* runCell(
        "const sheet = await screen.app({bundle_id: 'org.example.Editor', window_id: 82779}); " +
          "return await sheet.waitFor({window: 'hidden'});",
      );
      expect(hiddenRes.value).toMatchObject({ met: true, on_current_space: true });
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.effect(
  "T41 same-frame replacement and T41c paged lifted row: replacement stays observed-only, and paged lifted row emits no element_state",
  () =>
    Effect.gen(function* () {
      // 1. Same-frame replacement: same role/label/frame, different value -> observed:element_state, never confirmed.
      let vStep = 0;
      const { host } = fixture({
        get_window_state: {
          pid: 42,
          window_id: 7,
          tree_markdown: [
            '- [0] AXWindow "List"',
            '  - [1] AXButton "Delete" = "item-a" [actions=[press]]',
          ].join(String.fromCharCode(10)),
          elements_complete: false,
          elements: [
            { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "List" },
            {
              role: "AXButton",
              element_index: 1,
              element_token: "s1:1",
              label: "Delete",
              value: "item-a",
              frame: { x: 10, y: 20, w: 80, h: 24 },
              actions: ["AXPress"],
            },
          ],
        },
        verify_state: () => {
          vStep++;
          return {
            status: "satisfied",
            predicates: [
              verifyOutcome(0, {
                role: "AXButton",
                label: "Delete",
                value: vStep === 1 ? "item-a" : "item-b",
                frame: { x: 10, y: 20, w: 80, h: 24 },
              }),
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
      const delBtn = obs.elements.find((e) => e.index === 1);
      if (!delBtn) throw new Error("Missing Delete button");
      const clicked = yield* invokeEv(host, evCall("click", { elementRef: delBtn.ref }, ref));
      expect(clicked.category).toBe("unverifiable");
      expect(clicked.evidence).toContain('observed:element_state:value "item-a"→"item-b"');

      // 2. Paged lifted row: over-budget read puts lifted row on the second page, while a native row with the same label exists.
      const rows = 500;
      const nodes: Array<{
        index: number;
        role: string;
        depth: number;
        label?: string;
        text?: string;
        parent?: number;
      }> = [
        { index: 0, role: "AXWindow", depth: 0, label: "Monitor" },
        { index: 1, role: "AXOutline", depth: 1, parent: 0 },
      ];
      let next = 2;
      for (let r = 0; r < rows; r++) {
        const rIdx = next++;
        nodes.push({ index: rIdx, role: "AXRow", depth: 2, parent: 1 });
        nodes.push({ index: next++, role: "AXCell", depth: 3, parent: rIdx, text: "row-" + r });
      }
      const lastCellIdx = next - 1;
      const lastRowIdx = next - 2;
      const toolbar = next++;
      nodes.push({ index: toolbar, role: "AXToolbar", depth: 1, parent: 0 });
      nodes.push({ index: next++, role: "AXButton", depth: 2, parent: toolbar, label: "row-499" });
      const md = nodes
        .map(
          (n) =>
            "  ".repeat(n.depth) +
            "- " +
            (n.index === lastCellIdx ? "" : "[" + n.index + "] ") +
            (n.index === lastCellIdx ? "AXStaticText" : n.role) +
            (n.label ? ' "' + n.label + '"' : "") +
            (n.text ? ' = "' + n.text + '"' : ""),
        )
        .join(String.fromCharCode(10));
      const pagedFixture = fixture({
        get_window_state: {
          pid: 42,
          window_id: 7,
          tree_markdown: md,
          elements_complete: false,
          elements: nodes
            .filter((n) => n.index !== lastCellIdx)
            .map((n) => ({
              role: n.role,
              depth: n.depth,
              element_index: n.index,
              element_token: "s1:" + n.index,
              ...(n.label ? { label: n.label } : {}),
              ...(n.text ? { label: n.text, value: n.text } : {}),
              ...(n.parent !== undefined ? { parent_index: n.parent } : {}),
              actions: ["AXPress"],
            })),
        },
        verify_state: {
          status: "satisfied",
          predicates: [verifyOutcome(0, { role: "AXRow", label: "row-0", value: "changed" })],
        },
        click: { effect: "unverifiable" },
      });
      const pBound = yield* pagedFixture.host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const pRef = pBound.value as ScreenTargetRef;
      yield* pagedFixture.host.observe(call("get_window_state", {}, pRef), context);
      const page2 = (yield* pagedFixture.host.observe(
        call("get_window_state", { after: lastRowIdx }, pRef),
        context,
      )).value as ScreenObservation;
      const liftedRow2 = page2.elements.find((e) => e.index === lastRowIdx);
      if (!liftedRow2) throw new Error("Missing paged row");
      expect(liftedRow2.name).toBe("row-499");
      const pClicked = yield* invokeEv(
        pagedFixture.host,
        evCall("click", { elementRef: liftedRow2.ref }, pRef),
      );
      expect((pClicked.evidence ?? []).some((e) => e.startsWith("observed:element_state"))).toBe(
        false,
      );
    }),
);

it.live(
  "T45b/T45c/T45f/T51': batches, tight-budget inputs, empty end reads, opened-then-closed windows, and deadline/stop cells report windowsOpened accurately",
  () => {
    let scenario: "batch" | "openedClosed" | "emptyEnd" | "deadline" = "batch";
    let step = 0;
    let fireDeadline: (() => void) | undefined;
    const { host } = fixture({
      get_window_state: (args: Record<string, unknown>) => {
        if (scenario === "deadline" && step >= 3) fireDeadline?.();
        return goat2WindowState(args);
      },
      list_windows: () => {
        step++;
        if (scenario === "batch") {
          return step <= 1
            ? { windows: [win(7)] }
            : { windows: [win(7), win(82871, { title: "Batch Opened" })] };
        }
        if (scenario === "openedClosed") {
          // step 1: bind; step 2: pre input 1; step 3: post input 1 (82779 opened); step 4: pre input 2; step 5+: 82779 closed again
          if (step <= 2) return { windows: [win(7)] };
          if (step <= 4) return { windows: [win(7), win(82779, { title: "Temp Sheet" })] };
          return { windows: [win(7)] };
        }
        if (scenario === "emptyEnd") {
          if (step <= 2) return { windows: [win(7)] };
          if (step === 3) return { windows: [win(7), win(82779, { title: "Kept From Input" })] };
          return { windows: [] };
        }

        return step <= 2
          ? { windows: [win(7)] }
          : { windows: [win(7), win(82900, { title: "Before Deadline" })] };
      },
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
      click: () => {
        if (scenario === "deadline" && step >= 5 && fireDeadline) {
          fireDeadline();
        }
        return { effect: "unverifiable" };
      },
    });
    return Effect.gen(function* () {
      // T45b: batch opens window 82871 -> listed from cell end read
      const batchRes = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); " +
          "await Promise.all([app.click('Apply'), app.click('Apply')]);",
      );
      expect(batchRes.windowsOpened?.map((w) => w.window_id)).toEqual([82871]);

      // Window opened and closed during the same cell -> left out of windowsOpened
      scenario = "openedClosed";
      step = 0;
      const ocRes = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "await app.click([10, 10], {verify: true}); await app.screenshot(); await app.click([10, 10], {verify: true});",
      );
      expect(ocRes.windowsOpened).toBeUndefined();

      // T45f: empty end snapshot -> windowsOpenedUnverified:true and per-input window 82779 kept
      scenario = "emptyEnd";
      step = 0;
      const eeRes = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "await app.click([10, 10], {verify: true});",
      );
      expect(eeRes.windowsOpenedUnverified).toBe(true);
      expect(eeRes.windowsOpened?.map((w) => w.window_id)).toEqual([82779]);

      // T51': supervisor deadline after an input opened 82900 -> error carries 82900 and windowsOpenedUnverified:true
      scenario = "deadline";
      step = 0;
      const dlRes = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); " +
          "await app.click([10, 10], {verify: true}); await app.screenshot(); await new Promise(() => {});",
      ).pipe(Effect.result);
      expect(dlRes._tag).toBe("Failure");
      if (dlRes._tag === "Failure") {
        expect(dlRes.failure.windowsOpened?.map((w) => w.window_id)).toEqual([82900]);
        expect(dlRes.failure.windowsOpenedUnverified).toBe(true);
      }
    }).pipe(
      Effect.provide(
        cellService(host, (run) => {
          fireDeadline = run;
          return () => {
            fireDeadline = undefined;
          };
        }),
      ),
    );
  },
);

it.live(
  "audit r1 P1 #1 & P2 #5: auxiliary and end-of-cell reads pass the primitive channel reserve, and a batch in a later cell captures a fresh window baseline",
  () => {
    let step = 0;
    const base = fixture({
      get_window_state: (args: Record<string, unknown>) => goat2WindowState(args),
      list_windows: () => {
        step++;
        // Steps 1-4: cell 1 bind, click pre/post, finishCell; step 5: cell 2 batch baseline; step 6: cell 2 finishCell.
        if (step <= 2) return { windows: [win(7)] };
        if (step <= 4) return { windows: [win(7), win(8100, { title: "Cell1" })] };
        if (step === 5)
          return {
            windows: [win(7), win(8100, { title: "Cell1" }), win(9001, { title: "External" })],
          };
        return {
          windows: [
            win(7),
            win(8100, { title: "Cell1" }),
            win(9001, { title: "External" }),
            win(9002, { title: "BatchCell2" }),
          ],
        };
      },
      click: { effect: "unverifiable" },
    });
    // Wrap primitiveChannel so it enforces driverCallDeadline and MIN_CALL_MS like production ComputerUsePrimitiveChannel.
    const channelWithReserve = {
      request: (req: { tool: string; args: unknown; deadlineMillis: number }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const deadline = driverCallDeadline(req.tool, req.args, req.deadlineMillis, now);
          if (deadline - now < MIN_CALL_MS) {
            return yield* Effect.fail({
              code: "deadline" as const,
              effectStarted: false,
              nextStep: "Too little time left.",
            });
          }
          return yield* base.channel.request(req as never);
        }),
    };
    const host = createDesktopTargetHost({
      primitiveChannel: channelWithReserve as never,
      leases: base.leases,
      platform: "darwin",
    });
    return Effect.gen(function* () {
      const cell1 = yield* runCell(
        "globalThis.savedApp = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "await savedApp.observe(); const c = await savedApp.click('Apply', {verify: true}); return c.result.windows;",
      );
      expect(
        (cell1.value as { opened?: Array<{ window_id: number }> })?.opened?.map((w) => w.window_id),
      ).toEqual([8100]);
      expect(cell1.windowsOpened?.map((w) => w.window_id)).toEqual([8100]);
      expect(cell1.windowsOpenedUnverified).toBeUndefined();

      const cell2 = yield* runCell(
        "await Promise.all([savedApp.click('Apply'), savedApp.click('Apply')]); return 1;",
      );
      // 9001 opened before cell 2 started, so only 9002 was opened during cell 2.
      expect(cell2.windowsOpened?.map((w) => w.window_id)).toEqual([9002]);
      expect(cell2.windowsOpenedUnverified).toBeUndefined();
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live(
  "audit r1 P1 #2 & P2 #3: sheet follow updates app.windowId and note, and a failed parent read does not strand the binding",
  () => {
    let failParent = true;
    const { host } = fixture({
      list_windows: {
        windows: [win(72907, { title: "Recents" }), win(82779, { title: "Go to Folder" })],
      },
      get_window_state: (args: Record<string, unknown>) => {
        if (args.window_id === 82779) {
          return {
            pid: 42,
            window_id: 82779,
            degraded: true,
            degraded_reason: "window_is_sheet: window_id 82779 is a sheet attached to window 72907",
            sheet_of_window_id: 72907,
            elements_complete: false,
            tree_markdown: "",
            elements: [],
          };
        }
        if (failParent) {
          return new DriverError({ status: "failed" }, "Parent AX walk timed out");
        }
        return {
          pid: 42,
          window_id: 72907,
          snapshot_id: "s_parent",
          elements_complete: false,
          tree_markdown:
            '- [0] AXWindow "Recents"\n  - [1] AXSheet\n    - [2] AXButton "Go" [actions=[press]]',
          elements: [
            { role: "AXWindow", element_index: 0, element_token: "sp:0", label: "Recents" },
            { role: "AXSheet", element_index: 1, element_token: "sp:1" },
            {
              role: "AXButton",
              element_index: 2,
              element_token: "sp:2",
              label: "Go",
              actions: ["AXPress"],
            },
          ],
        };
      },
    });
    return Effect.gen(function* () {
      const res = yield* runCell(
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 82779}); " +
          "const firstErr = await app.observe().then(() => 'ok', (e) => e.code); " +
          "globalThis.sheetApp = app; return { firstErr, winBefore: app.windowId, genBefore: app.generation };",
      );
      expect(res.value).toMatchObject({ firstErr: "downstream_failure", winBefore: 82779 });

      // Now parent read succeeds: the same bound target recovers and updates windowId + note.
      failParent = false;
      const recovered = yield* runCell(
        "const obs = await sheetApp.observe(); " +
          "return { winAfter: sheetApp.windowId, note: sheetApp.note, scope: obs.scope, count: obs.elements.length };",
      );
      expect(recovered.value).toEqual({
        winAfter: 72907,
        note: expect.stringContaining("sheet of window 72907"),
        scope: "sheet 82779 of window 72907",
        count: 3,
      });
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.effect(
  "audit r1 P2 #4: waitFor({window:'hidden'}) polls until the window becomes offscreen",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const { host } = fixture({
        list_windows: () => {
          reads++;
          return {
            windows: [
              win(7, {
                is_on_screen: reads < 4,
                on_current_space: true,
              }),
            ],
          };
        },
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const fiber = yield* host
        .invoke(
          {
            ...call("wait_for", { window: "hidden", timeoutMs: 1000 }, ref),
            deadlineMillis: 10000,
          },
          context,
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      const out = yield* Fiber.join(fiber);
      expect(out.category).toBe("confirmed");
      expect(out.value).toMatchObject({ met: true, status: "satisfied", on_current_space: true });
      expect(reads).toBeGreaterThanOrEqual(4);
    }),
);

it.effect(
  "audit r2: pre-input evidence reserves the input cap, sheet follow validates the sheet reply and updates parent bounds/title, and hidden wait bounds slow reads",
  () =>
    Effect.gen(function* () {
      // 1. Pre-input evidence skipped when only 2,600 ms remain (click needs 3,000 + 1,500 reserve), so click is not starved.
      let delayList = false;
      const base = fixture({
        list_windows: { windows: [win(7)] },
        click: { effect: "unverifiable" },
      });
      const channel = {
        request: (req: {
          tool: string;
          args: unknown;
          deadlineMillis: number;
          optional?: boolean;
        }) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const dl = driverCallDeadline(req.tool, req.args, req.deadlineMillis, now);
            if (dl - now < MIN_CALL_MS)
              return yield* Effect.fail({
                code: "deadline" as const,
                effectStarted: false,
                nextStep: "Starved.",
              });
            if (delayList && req.tool === "list_windows") yield* TestClock.adjust("900 millis");
            return yield* base.channel.request(req as never);
          }),
      };
      const host = createDesktopTargetHost({
        primitiveChannel: channel as never,
        leases: base.leases,
        platform: "darwin",
      });
      const bound = yield* host.bindApp(
        {
          ...call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
          deadlineMillis: 50_000,
        },
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      delayList = true;
      const beforeTight = base.sent.length;
      const tightClick = yield* host.invoke(
        {
          ...call("click", { x: 10, y: 10, coordinate_space: "window_points" }, ref),
          deadlineMillis: 2_600,
        },
        context,
      );
      expect(tightClick.category).toBe("unverifiable");
      // Pre-input list_windows was skipped to preserve the click budget, so click was the first call sent.
      expect(base.sent[beforeTight]?.tool).toBe("click");

      // 2. Mismatched sheet reply (wrong window_id) fails stale_reference before following sheet_of_window_id.
      const mismatch = fixture({
        list_windows: { windows: [win(82779), win(72907)] },
        get_window_state: (args: Record<string, unknown>) =>
          args.window_id === 82779
            ? {
                pid: 42,
                window_id: 99999,
                degraded: true,
                sheet_of_window_id: 72907,
                elements: [],
                tree_markdown: "",
              }
            : { pid: 42, window_id: 72907, elements: [], tree_markdown: "" },
      });
      const mBound = yield* mismatch.host.bindApp(
        evCall("bind_app", { bundle_id: "org.example.Editor", window_id: 82779 }),
        context,
      );
      const mObs = yield* mismatch.host
        .observe(evCall("get_window_state", {}, mBound.value as ScreenTargetRef), context)
        .pipe(Effect.result);
      expect(mObs._tag === "Failure" && mObs.failure.code).toBe("stale_reference");
      expect(mismatch.sent.filter((s) => s.tool === "get_window_state")).toHaveLength(1);

      // 3. Sheet follow replaces sheet windowBounds with parent bounds even when parent tree has no root window frame, and sets observation.title.
      const geom = fixture({
        list_windows: {
          windows: [
            win(82779, { title: "Sheet", bounds: { x: 200, y: 200, width: 300, height: 150 } }),
            win(72907, { title: "Parent Doc", bounds: { x: 10, y: 20, width: 800, height: 600 } }),
          ],
        },
        get_window_state: (args: Record<string, unknown>) =>
          args.window_id === 82779
            ? {
                pid: 42,
                window_id: 82779,
                degraded: true,
                sheet_of_window_id: 72907,
                elements: [],
                tree_markdown: "",
              }
            : {
                pid: 42,
                window_id: 72907,
                window_title: "Parent Doc",
                elements_complete: false,
                tree_markdown: '  - [1] AXButton "Go" [actions=[press]]',
                elements: [
                  {
                    role: "AXButton",
                    element_index: 1,
                    element_token: "sp:1",
                    label: "Go",
                    actions: ["AXPress"],
                  },
                ],
              },
        click: { effect: "unverifiable" },
      });
      const gBound = yield* geom.host.bindApp(
        evCall("bind_app", { bundle_id: "org.example.Editor", window_id: 82779 }),
        context,
      );
      const gObs = (yield* geom.host.observe(
        evCall("get_window_state", {}, gBound.value as ScreenTargetRef),
        context,
      )).value as ScreenObservation;
      expect(gObs.title).toBe("Parent Doc");
      yield* invokeEv(
        geom.host,
        evCall("click", { x: 50, y: 60, coordinate_space: "window_points" }, gObs.targetRef),
      );
      expect(geom.sent.find((s) => s.tool === "click")?.args).toMatchObject({
        window_basis: { x: 10, y: 20, w: 800, h: 600 },
      });

      // 4. Slow list_windows during waitFor({window:"hidden"}, 100) is bounded by the 100 ms wait and does not report met:true late.
      let slowWait = false;
      const slowBase = fixture({
        list_windows: { windows: [win(7, { is_on_screen: false, on_current_space: true })] },
      });
      const slowHost = createDesktopTargetHost({
        primitiveChannel: {
          request: (req: { tool: string }) =>
            slowWait && req.tool === "list_windows"
              ? Effect.sleep("500 millis").pipe(
                  Effect.andThen(slowBase.channel.request(req as never)),
                )
              : slowBase.channel.request(req as never),
        } as never,
        leases: slowBase.leases,
        platform: "darwin",
      });
      const sBound = (yield* slowHost.bindApp(
        evCall("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      )).value as ScreenTargetRef;
      slowWait = true;
      const wFiber = yield* slowHost
        .invoke(
          {
            ...call("wait_for", { window: "hidden", timeoutMs: 100 }, sBound),
            deadlineMillis: 50_000,
          },
          context,
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("150 millis");
      const wOut = yield* Fiber.join(wFiber);
      expect(wOut.value).toMatchObject({ met: false, status: "unsatisfied" });

      // 5. End-of-cell read skipped when cellDeadlineMillis has no time left.
      if (!geom.host.finishCell) throw new Error("finishCell missing");
      const endSkip = yield* geom.host.finishCell(context, {
        skipEndRead: false,
        cellDeadlineMillis: 500,
      } as never);
      expect(endSkip.windowsOpenedUnverified).toBe(true);
    }),
);

it.effect(
  "audit r3 & r4: short hidden wait returns met:false after driver replacement; and oversized titles drop before elements",
  () =>
    Effect.gen(function* () {
      // 1. Short hidden wait (50 ms) after driver replacement with 5 ms admission delay returns met:false without failing deadline.
      const conn = { id: "driver:1" };
      const rebindBase = fixture(
        {
          list_windows: { windows: [win(7, { is_on_screen: true })] },
        },
        conn,
      );
      const rebindChannel = {
        request: (req: {
          tool: string;
          args: unknown;
          deadlineMillis: number;
          expectedConnectionGeneration?: string;
        }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("5 millis");
            const now = yield* Clock.currentTimeMillis;
            const dl = driverCallDeadline(req.tool, req.args, req.deadlineMillis, now);
            if (dl - now < MIN_CALL_MS)
              return yield* Effect.fail({
                code: "deadline" as const,
                effectStarted: false,
                nextStep: "Too short.",
              });
            return yield* rebindBase.channel.request(req as never);
          }),
      };
      const rebindHost = createDesktopTargetHost({
        primitiveChannel: rebindChannel as never,
        leases: rebindBase.leases,
        platform: "darwin",
      });
      const rBound = (yield* rebindHost.bindApp(
        {
          ...call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
          deadlineMillis: 500_000,
        },
        context,
      )).value as ScreenTargetRef;
      conn.id = "driver:2";
      const shortWaitFiber = yield* rebindHost
        .invoke(
          {
            ...call("wait_for", { window: "hidden", timeoutMs: 50 }, rBound),
            deadlineMillis: 500_000,
          },
          context,
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      const shortWaitOut = yield* Fiber.join(shortWaitFiber);
      expect(shortWaitOut.value).toMatchObject({ met: false, status: "unsatisfied" });

      // 3. Desktop title > 1,024 chars is clipped to 1,024, and under a tight treeBytes budget the title is dropped first so usable elements survive.
      const longTitle = "T".repeat(1500);
      const titleFix = fixture({
        get_window_state: {
          pid: 42,
          window_id: 7,
          window_title: longTitle,
          elements_complete: false,
          tree_markdown: '- [0] AXWindow "Doc"',
          elements: [{ role: "AXWindow", element_index: 0, element_token: "s1:0", label: "Doc" }],
        },
      });
      const tBound = (yield* titleFix.host.bindApp(
        evCall("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      )).value as ScreenObservation["targetRef"];
      const normalObs = (yield* titleFix.host.observe(
        evCall("get_window_state", {}, tBound),
        context,
      )).value as ScreenObservation;
      expect(normalObs.title).toHaveLength(1024);
      const tightObs = (yield* titleFix.host.observe(evCall("get_window_state", {}, tBound), {
        ...context,
        limits: { ...context.limits, returnBytes: 1200 },
      })).value as ScreenObservation;
      expect(tightObs.title).toBeUndefined();
      expect(tightObs.elements).toHaveLength(1);
      expect(tightObs.truncated).toBe(true);
    }),
);
