import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import { normalizeSheetState } from "./DesktopInputPlan.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { call, context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

// Shapes from the 2026-10-29 evaluation (goat_screen_run_calls.jsonl G47, G78, G83): Finder
// window 72907 opens Go to Folder as untitled window 82779 (460x183). The Go to Folder tree is
// synthesized from Codex's read of it (codex_cua_calls.jsonl C20) in the goat.10 element shape:
// no identifier field, the id only in the tree text, the path field labelled with its value.

const win = (windowId: number, extra: Record<string, unknown> = {}) => ({
  pid: 42,
  window_id: windowId,
  app_name: "Editor",
  title: "Recents",
  bounds: { x: 0, y: 0, width: 1325, height: 556 },
  is_on_screen: true,
  on_current_space: true,
  ...extra,
});
const GOTO_WINDOW = { title: "", bounds: { x: 430, y: 300, width: 460, height: 183 } };

const finderTree = (windowId: number, title = "Recents") => ({
  pid: 42,
  window_id: windowId,
  window_title: title,
  snapshot_id: "s" + windowId,
  elements_complete: false,
  tree_markdown: [
    '- [0] AXWindow "' + title + '"',
    '  - [2] AXOutline "Files"',
    "    - [3] AXRow",
    '      - [41] AXTextField "Math Problem 13 × 2 + 7 = 33"',
  ].join("\n"),
  elements: [
    { role: "AXWindow", element_index: 0, element_token: windowId + ":0", label: title },
    { role: "AXOutline", element_index: 2, element_token: windowId + ":2", parent_index: 0 },
    { role: "AXRow", element_index: 3, element_token: windowId + ":3", parent_index: 2 },
    {
      role: "AXTextField",
      element_index: 41,
      element_token: windowId + ":41",
      label: "Math Problem 13 × 2 + 7 = 33",
      value: "Math Problem 13 × 2 + 7 = 33",
      parent_index: 3,
    },
  ],
});
const gotoTree = {
  pid: 42,
  window_id: 82779,
  snapshot_id: "s82779",
  elements_complete: false,
  tree_markdown: [
    '- [0] AXSheet "GoToWindow" [id=GoToWindow actions=[raise]]',
    '  - [1] AXButton "Close" [id=CloseButton actions=[press]]',
    '  - [2] AXTextField = "/Users/jun/Downloads" [id=PathTextField actions=[confirm]]',
  ].join("\n"),
  elements: [
    { role: "AXSheet", element_index: 0, element_token: "s82779:0", label: "GoToWindow" },
    { role: "AXButton", element_index: 1, element_token: "s82779:1", label: "Close" },
    {
      role: "AXTextField",
      element_index: 2,
      element_token: "s82779:2",
      label: "/Users/jun/Downloads",
      value: "/Users/jun/Downloads",
      parent_index: 0,
    },
  ],
};

/** Finder that opens Go to Folder on cmd+shift+g and closes it on Return. */
const finder = (
  options: { sheetRead?: "tree" | "empty" | "fails"; opened?: () => unknown[] } = {},
) => {
  const state = { open: false, readFails: false, navigated: false };
  const title = () => (state.navigated ? "computeruse" : "Recents");
  const made = fixture({
    list_windows: () => ({
      windows: [
        win(72907, { title: title() }),
        win(72908, { title: "Downloads" }),
        ...(state.open ? (options.opened?.() ?? [win(82779, GOTO_WINDOW)]) : []),
      ],
    }),
    get_window_state: (args: Record<string, unknown>) => {
      if (args.window_id !== 82779) return finderTree(Number(args.window_id), title());
      if (state.readFails || options.sheetRead === "fails" || !state.open)
        return new DriverError({ code: "window_not_found" }, "no such window");
      return options.sheetRead === "empty"
        ? { ...gotoTree, elements: [], tree_markdown: "" }
        : gotoTree;
    },
    press_key: (args: Record<string, unknown>) => {
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
      if (args.key === "g" && modifiers.includes("command") && modifiers.includes("shift"))
        state.open = true;
      if ((args.key === "Enter" || args.key === "Return") && state.open) {
        state.open = false;
        state.navigated = true;
      }
      return { effect: "unverifiable" };
    },
  });
  return { ...made, state };
};

const service = (host: ReturnType<typeof fixture>["host"]) =>
  ScreenRunService.layerWithRuntime({
    dispatcher: createScreenDispatchRouter({ app: host }),
    desktopHost: host,
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
  }).pipe(Layer.provide(NodeServices.layer));

const cell = (source: string) =>
  Effect.gen(function* () {
    const run = yield* ScreenRunService;
    return yield* run.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source,
    });
  });

// A call deadline no test reaches; the gated test runs on the live clock.
const FAR_DEADLINE = 10 ** 15;

const BIND =
  "const app = await screen.app({ bundle_id: 'org.example.Editor', window_id: 72907 }); await app.observe();";

it.live(
  "after cmd+shift+g opens Go to Folder as its own window, the input reports it, observe() moves onto it with its PathTextField named, and comes back once a fresh window list shows it closed",
  () => {
    const { host, sent } = finder();
    return Effect.gen(function* () {
      const result = yield* cell(
        BIND +
          "const done = await app.press('cmd+shift+g');" +
          "const sheet = await app.observe();" +
          "const field = sheet.elements.find((e) => e.name === 'PathTextField');" +
          "const onSheet = app.windowId;" +
          "await app.setValue(field.index, '~/Developer/codex/computeruse');" +
          "await app.press('Enter');" +
          "const back = await app.observe();" +
          "return { observed: done.observed, opened: done.result.windows.opened.map((w) => w.window_id), onSheet, text: sheet.text, backWindow: app.windowId, backTitle: back.title, scope: back.scope };",
      );
      expect(result.value).toMatchObject({
        observed: expect.arrayContaining([
          "observed:window_opened:82779",
          expect.stringContaining("observed:sheet_candidate:82779"),
        ]),
        opened: [82779],
        onSheet: 82779,
        text: expect.stringContaining('[2] AXTextField "PathTextField" = "/Users/jun/Downloads"'),
        backWindow: 72907,
        backTitle: "computeruse",
        scope: "sheet 82779 of window 72907",
      });
      expect(sent.find((entry) => entry.tool === "set_value")?.args).toMatchObject({
        element_token: "s82779:2",
        value: "~/Developer/codex/computeruse",
      });
    }).pipe(Effect.provide(service(host)));
  },
);

it.live(
  "a followed sheet that is still listed on screen but cannot be read surfaces the failure on the same binding and does not jump back",
  () => {
    const { host, state } = finder();
    return Effect.gen(function* () {
      const first = yield* cell(
        BIND +
          "globalThis.saved = app; await app.press('cmd+shift+g'); await app.observe(); return app.windowId;",
      );
      expect(first.value).toBe(82779);
      state.readFails = true;
      const second = yield* cell(
        "try { await saved.observe(); return 'read'; } catch (e) { return [e.code, saved.windowId]; }",
      );
      expect(second.value).toEqual(["downstream_failure", 82779]);
    }).pipe(Effect.provide(service(host)));
  },
);

it.live(
  "an observe with no Go to Folder input or followed sheet reads only the bound window, with no window list",
  () => {
    const { host, sent } = finder();
    return Effect.gen(function* () {
      yield* cell(BIND + "globalThis.saved = app; await app.press('cmd+a');");
      const before = sent.length;
      yield* cell("await saved.observe();");
      expect(sent.slice(before).map((entry) => entry.tool)).toEqual(["get_window_state"]);
    }).pipe(Effect.provide(service(host)));
  },
);

it.live(
  "the Go to Folder input of one binding is followed only when no other binding of the app sent input in the cell before it returned, also from a later cell",
  () => {
    const { host } = finder();
    const OTHER =
      "const other = await screen.app({ bundle_id: 'org.example.Editor', window_id: 72908 }); await other.observe();";
    return Effect.gen(function* () {
      const before = yield* cell(
        BIND +
          OTHER +
          "await other.press('Escape'); await app.press('cmd+shift+g'); await app.observe(); return app.windowId;",
      );
      expect(before.value).toBe(72907);
      yield* cell(
        "const app = await screen.app({ bundle_id: 'org.example.Editor', window_id: 72907 }); await app.press('Enter');",
      );
      const after = yield* cell(
        BIND +
          OTHER +
          "await app.press('cmd+shift+g'); await other.observe(); await other.press('Escape'); await app.observe(); return app.windowId;",
      );
      expect(after.value).toBe(82779);
      yield* cell(
        "const app = await screen.app({ bundle_id: 'org.example.Editor', window_id: 82779 }); await app.press('Enter');",
      );
      yield* cell(BIND + "globalThis.saved = app; await app.press('cmd+shift+g');");
      const later = yield* cell("await saved.observe(); return saved.windowId;");
      expect(later.value).toBe(82779);
    }).pipe(Effect.provide(service(host)));
  },
);

it.live(
  "no follow without a Go to Folder input, when two windows open, when the opened window is titled, or when it is gone from a fresh list; unidentified windows are named in an omitted note",
  () =>
    Effect.gen(function* () {
      const plain = finder();
      const plainRun = yield* cell(
        BIND + "await app.press('cmd+n'); await app.observe(); return app.windowId;",
      ).pipe(Effect.provide(service(plain.host)));
      expect(plainRun.value).toBe(72907);
      for (const opened of [
        () => [win(82779, GOTO_WINDOW), win(82780, GOTO_WINDOW)],
        () => [win(82779, { ...GOTO_WINDOW, title: "Info" })],
      ]) {
        const { host } = finder({ opened });
        const run = yield* cell(
          BIND +
            "await app.press('cmd+shift+g'); const o = await app.observe(); return [app.windowId, (o.omitted ?? []).map((n) => n.detail).join(' ')];",
        ).pipe(Effect.provide(service(host)));
        expect(run.value).toEqual([
          72907,
          expect.stringContaining("could not be identified as its sheet"),
        ]);
      }
      const stale = finder();
      yield* Effect.gen(function* () {
        yield* cell(BIND + "globalThis.saved = app; await app.press('cmd+shift+g');");
        stale.state.open = false;
        const reads = () => stale.sent.filter((e) => e.tool === "get_window_state").length;
        const before = reads();
        const after = yield* cell("await saved.observe(); return saved.windowId;");
        expect(after.value).toBe(72907);
        expect(
          stale.sent
            .slice(-(reads() - before) - 2)
            .some((e) => (e.args as { window_id?: number }).window_id === 82779),
        ).toBe(false);
      }).pipe(Effect.provide(service(stale.host)));
    }),
);

it.live(
  "an opened sheet with no elements or a failed read leaves observe() on the bound window with fresh element numbers and a note naming the window",
  () =>
    Effect.gen(function* () {
      for (const [sheetRead, words] of [
        ["empty", "returned no elements"],
        ["fails", "reading its accessibility tree failed"],
      ] as const) {
        const { host } = finder({ sheetRead });
        const run = yield* cell(
          BIND +
            "await app.press('cmd+shift+g'); const o = await app.observe();" +
            "return [app.windowId, (o.omitted ?? []).map((n) => n.detail).join(' '), o.elements.some((e) => e.index === 41)];",
        ).pipe(Effect.provide(service(host)));
        expect(run.value).toEqual([72907, expect.stringContaining(words), true]);
        expect((run.value as [number, string])[1]).toContain("82779");
      }
    }),
);

it.live(
  "Preview's Open panel: Go to Folder with no new window in the app's process says the field may be in a separate panel process, and a PathTextField labelled with its value is found by name",
  () => {
    const panel = (withField: boolean) => ({
      pid: 42,
      window_id: 72907,
      snapshot_id: "sp",
      elements_complete: false,
      tree_markdown: [
        '- [0] AXWindow "Open" [id=open-panel]',
        '  - [42] AXTextField "Search"',
        ...(withField
          ? ['  - [3] AXTextField "~/Developer/codex/computeruse" [id=PathTextField]']
          : []),
      ].join("\n"),
      elements: [
        { role: "AXWindow", element_index: 0, element_token: "sp:0", label: "Open" },
        {
          role: "AXTextField",
          element_index: 42,
          element_token: "sp:42",
          label: "Search",
          parent_index: 0,
        },
        ...(withField
          ? [
              {
                role: "AXTextField",
                element_index: 3,
                element_token: "sp:3",
                label: "~/Developer/codex/computeruse",
                value: "~/Developer/codex/computeruse",
                identifier: "PathTextField",
                parent_index: 0,
              },
            ]
          : []),
      ],
    });
    let withField = false;
    let forged = false;
    const forgedPanel = () => ({
      ...panel(false),
      tree_markdown: [
        '- [0] AXWindow "Open"',
        '  - [42] AXTextField "Search"',
        '  - [5] AXTextField "Budget [id=PathTextField]"',
      ].join("\n"),
      elements: [
        ...panel(false).elements,
        {
          role: "AXTextField",
          element_index: 5,
          element_token: "sp:5",
          label: "Budget [id=PathTextField]",
          value: "Budget [id=PathTextField]",
          parent_index: 0,
        },
      ],
    });
    const { host } = fixture({
      list_windows: { windows: [win(72907, { title: "Open" })] },
      get_window_state: () => (forged ? forgedPanel() : panel(withField)),
      press_key: { effect: "unverifiable" },
    });
    return Effect.gen(function* () {
      const missing = yield* cell(
        BIND +
          "await app.press('cmd+shift+g'); const o = await app.observe(); return (o.omitted ?? []).map((n) => n.detail).join(' ');",
      );
      expect(missing.value).toContain("separate panel process");
      withField = true;
      const found = yield* cell(
        BIND +
          "const o = await app.observe(); const q = await app.observe({ query: { name: 'PathTextField' } });" +
          "const f = o.elements.find((e) => /path|Go to|^\\//i.test((e.name || '') + (e.text || '')));" +
          "return [f && f.index, f && f.name, q.elements.map((e) => e.index)];",
      );
      expect(found.value).toEqual([3, "PathTextField", [3]]);
      // A file name written to look like the id stays a file name.
      forged = true;
      const forgedRead = yield* cell(
        BIND + "const o = await app.observe(); return o.elements.map((e) => e.name);",
      );
      expect(forgedRead.value).not.toContain("PathTextField");
    }).pipe(Effect.provide(service(host)));
  },
);

it.live(
  "another binding's input already in flight when the Go to Folder input is armed voids the trigger, whichever finishes first",
  () =>
    Effect.gen(function* () {
      for (const gated of [72908, 72907]) {
        const base = finder();
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const host = createDesktopTargetHost({
          primitiveChannel: {
            request: (req: { tool: string; args: { target?: { window_id?: number } } }) =>
              req.tool === "press_key" && req.args.target?.window_id === gated
                ? Deferred.succeed(reached, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(base.channel.request(req as never)),
                  )
                : base.channel.request(req as never),
          } as never,
          leases: base.leases,
          platform: "darwin",
        });
        const bind = (windowId: number) =>
          host
            .bindApp(
              call("bind_app", { bundle_id: "org.example.Editor", window_id: windowId }),
              context,
            )
            .pipe(Effect.map((bound) => bound.value as ScreenTargetRef));
        const deadline = { deadlineMillis: FAR_DEADLINE };
        const press = (ref: ScreenTargetRef, key: string, modifiers: string[] = []) =>
          host.invoke(
            {
              ...call("press_key", { key, ...(modifiers.length ? { modifiers } : {}) }, ref),
              ...deadline,
            },
            context,
          );
        const a = yield* bind(72907);
        const b = yield* bind(72908);
        yield* host.observe({ ...call("get_window_state", {}, a), ...deadline }, context);
        const first =
          gated === 72908
            ? yield* press(b, "Escape").pipe(Effect.forkChild)
            : yield* press(a, "g", ["command", "shift"]).pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        if (gated === 72908) yield* press(a, "g", ["command", "shift"]);
        else yield* press(b, "Escape");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        const read = (yield* host.observe(
          { ...call("get_window_state", {}, a), ...deadline },
          context,
        )).value as ScreenObservation;
        expect(read.scope).not.toContain("sheet");
        expect(read.elements.some((e) => e.index === 41)).toBe(true);
      }
      // Control: the same Go to Folder input alone is followed.
      const alone = finder();
      const ref = (yield* alone.host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 72907 }),
        context,
      )).value as ScreenTargetRef;
      const deadline = { deadlineMillis: FAR_DEADLINE };
      yield* alone.host.observe({ ...call("get_window_state", {}, ref), ...deadline }, context);
      yield* alone.host.invoke(
        { ...call("press_key", { key: "g", modifiers: ["command", "shift"] }, ref), ...deadline },
        context,
      );
      const followed = (yield* alone.host.observe(
        { ...call("get_window_state", {}, ref), ...deadline },
        context,
      )).value as ScreenObservation;
      expect(followed.scope).toBe("sheet 72907 of window 82779");
    }),
);

it("the path field's tree line keeps its own metadata whole, and a second line for the same number makes the tree id unknown", () => {
  const field = (extra: Record<string, unknown>) => ({
    role: "AXTextField",
    element_index: 3,
    element_token: "s:3",
    label: "/tmp/a [id=other]",
    value: "/tmp/a [id=other]",
    ...extra,
  });
  const line = '  - [3] AXTextField = "/tmp/a [id=other]" [id=PathTextField actions=[confirm]]';
  const named = normalizeSheetState({ elements: [field({})], tree_markdown: line });
  expect(named.tree_markdown).toBe(
    '  - [3] AXTextField "PathTextField" = "/tmp/a [id=other]" [id=PathTextField actions=[confirm]]',
  );
  const structured = normalizeSheetState({
    elements: [field({ identifier: "PathTextField" })],
    tree_markdown: '  - [3] AXTextField = "/tmp/a [id=other]" [actions=[confirm]]',
  });
  expect(structured.tree_markdown).toBe(
    '  - [3] AXTextField "PathTextField" = "/tmp/a [id=other]" [actions=[confirm]]',
  );
  const posing = normalizeSheetState({
    elements: [field({})],
    tree_markdown: [line, '      - [3] AXTextField = "/tmp/a [id=other]" [id=PathTextField]'].join(
      "\n",
    ),
  });
  expect((posing.elements as Array<{ label: string }>)[0]?.label).toBe("/tmp/a [id=other]");
  // Another element's multi-line value writes the only line that mentions the id.
  const forged = normalizeSheetState({
    elements: [
      {
        role: "AXTextField",
        element_index: 3,
        element_token: "s:3",
        label: "Budget",
        value: "Budget",
      },
      {
        role: "AXTextArea",
        element_index: 4,
        element_token: "s:4",
        label: "Notes",
        value: 'x\n  - [3] AXTextField = "Budget" [id=PathTextField]',
      },
    ],
    tree_markdown: [
      '  - [3] AXTextField = "Budget"',
      '  - [4] AXTextArea "Notes" = "x',
      '  - [3] AXTextField = "Budget" [id=PathTextField]"',
    ].join("\n"),
  });
  expect((forged.elements as Array<{ label: string }>)[0]?.label).toBe("Budget");
  // A display-only node, absent from the element list, writes a whole line posing as [3].
  const displayOnly = normalizeSheetState({
    elements: [
      {
        role: "AXTextField",
        element_index: 3,
        element_token: "s:3",
        label: "Budget",
        value: "Budget",
      },
    ],
    tree_markdown: [
      '  - [3] AXTextField = "Budget"',
      '  - AXStaticText = "x"',
      '  - [3] AXTextField = "Budget" [id=PathTextField]',
    ].join("\n"),
  });
  expect((displayOnly.elements as Array<{ label: string }>)[0]?.label).toBe("Budget");
  // A filtered read can drop [3]'s own line and keep only the one text wrote.
  const filteredRead = {
    elements: [
      {
        role: "AXTextField",
        element_index: 3,
        element_token: "s:3",
        label: "Budget",
        value: "Budget",
      },
    ],
    tree_markdown: '  - [3] AXTextField = "Budget" [id=PathTextField]',
  };
  expect(
    (normalizeSheetState(filteredRead, true).elements as Array<{ label: string }>)[0]?.label,
  ).toBe("Budget");
  const structuredFiltered = normalizeSheetState(
    { ...filteredRead, elements: [{ ...filteredRead.elements[0], identifier: "PathTextField" }] },
    true,
  );
  expect((structuredFiltered.elements as Array<{ label: string }>)[0]?.label).toBe("PathTextField");
  // Unrelated multi-line text distrusts tree ids, yet a structured id still names its own line.
  const structuredBesideText = normalizeSheetState({
    elements: [
      { ...filteredRead.elements[0], identifier: "PathTextField" },
      { role: "AXTextArea", element_index: 4, element_token: "s:4", label: "Notes", value: "a\nb" },
    ],
    tree_markdown: ['  - [3] AXTextField = "Budget"', '  - [4] AXTextArea "Notes" = "a', 'b"'].join(
      "\n",
    ),
  });
  expect(String(structuredBesideText.tree_markdown).split("\n")[0]).toBe(
    '  - [3] AXTextField "PathTextField" = "Budget"',
  );
  const multiLineValue = {
    elements: [
      { role: "AXTextField", element_index: 3, identifier: "PathTextField", value: "a\nb" },
    ],
    tree_markdown: ['  - [3] AXTextField = "a', 'b"'].join("\n"),
  };
  expect(normalizeSheetState(multiLineValue).tree_markdown).toBe(multiLineValue.tree_markdown);
});
