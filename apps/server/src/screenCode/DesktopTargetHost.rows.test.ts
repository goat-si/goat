import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

type Entry = {
  readonly index: number;
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
  readonly actions?: ReadonlyArray<string>;
};
const element = ({ index, role, label, value, actions }: Entry) => ({
  role,
  depth: 1,
  element_index: index,
  element_token: `s1:${index}`,
  ...(label === undefined ? {} : { label }),
  ...(value === undefined ? {} : { value }),
  ...(actions === undefined ? {} : { actions }),
});

/** Binds the fixture's window and reads it once with the given driver tree. */
const read = (tree: ReadonlyArray<string>, entries: ReadonlyArray<Entry>) =>
  Effect.gen(function* () {
    const { host } = fixture({
      get_window_state: {
        pid: 42,
        window_id: 7,
        tree_markdown: tree.join("\n"),
        elements_complete: false,
        elements: entries.map(element),
      },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const observed = yield* host.observe(
      call("get_window_state", {}, bound.value as ScreenTargetRef),
      context,
    );
    return observed.value as ScreenObservation;
  });

const byIndex = (observation: ScreenObservation) =>
  Object.fromEntries(observation.elements.map((each) => [each.index, each]));

it.effect("Finder rows and cells take the file name written under them", () =>
  Effect.gen(function* () {
    const observation = yield* read(
      [
        '- [0] AXWindow "Recents" [actions=[raise]]',
        "  - [1] AXOutline",
        "    - [2] AXRow [actions=[showdefaultui]]",
        "      - [3] AXCell",
        '        - AXStaticText = "Screenshot 2026-10-28.png"',
      ],
      [
        { index: 0, role: "AXWindow", label: "Recents" },
        { index: 1, role: "AXOutline" },
        { index: 2, role: "AXRow", actions: ["AXShowDefaultUI"] },
        { index: 3, role: "AXCell" },
      ],
    );
    const elements = byIndex(observation);
    expect(elements[3]?.name).toBe("Screenshot 2026-10-28.png");
    // The row's text is under its numbered cell, so the cell alone carries the name.
    expect(elements[2]?.name).toBe("");
  }),
);

it.effect("a sidebar item is found by name exactly once", () =>
  Effect.gen(function* () {
    // System Settings: the row is unnamed, its child button carries the name and id.
    const settings = yield* read(
      [
        "      - [2] AXOutline (Sidebar) [id=com.apple.settings.sidebar.collectionView]",
        "        - [22] AXRow [actions=[showdefaultui,showalternateui]]",
        "            - [23] AXButton (General) [id=com.apple.settings.general actions=[press]]",
      ],
      [
        { index: 2, role: "AXOutline", label: "Sidebar" },
        { index: 22, role: "AXRow", actions: ["AXShowDefaultUI", "AXShowAlternateUI"] },
        { index: 23, role: "AXButton", label: "General", actions: ["AXPress"] },
      ],
    );
    expect(
      settings.elements.filter((each) => each.name === "General").map((each) => each.index),
    ).toEqual([23]);
    // Screen Sharing: the row's name is a display-only text under it.
    const sharing = yield* read(
      ["  - [4] AXOutline", "    - [5] AXRow", '      - AXStaticText = "All Connections"'],
      [
        { index: 4, role: "AXOutline" },
        { index: 5, role: "AXRow" },
      ],
    );
    expect(
      sharing.elements.filter((each) => each.name === "All Connections").map((each) => each.index),
    ).toEqual([5]);
  }),
);

it.effect("a table's first cell is named by its text and found once; its row stays unnamed", () =>
  Effect.gen(function* () {
    const observation = yield* read(
      [
        "  - [10] AXTable",
        "    - [11] AXRow",
        "      - [12] AXCell",
        '        - AXStaticText = "WindowServer"',
        "      - [13] AXCell",
        '        - AXStaticText = "72.9"',
      ],
      [
        { index: 10, role: "AXTable" },
        { index: 11, role: "AXRow" },
        { index: 12, role: "AXCell" },
        { index: 13, role: "AXCell" },
      ],
    );
    const elements = byIndex(observation);
    expect([elements[11]?.name, elements[12]?.name, elements[13]?.name]).toEqual([
      "",
      "WindowServer",
      "72.9",
    ]);
  }),
);

it.effect("elements carry their accessibility id", () =>
  Effect.gen(function* () {
    const observation = yield* read(
      ["- [23] AXButton (General) [id=com.apple.settings.general actions=[press]]"],
      [{ index: 23, role: "AXButton", label: "General", actions: ["AXPress"] }],
    );
    expect(observation.elements[0]).toMatchObject({
      id: "com.apple.settings.general",
      name: "General",
    });
  }),
);

it.effect("an id written in a title or value never becomes the element's id", () =>
  Effect.gen(function* () {
    const observation = yield* read(
      [
        '- [7] AXButton "Save [id=delete]" [id=save actions=[press]]',
        '- [8] AXTextField "Note" = "x [id=send]"',
        "- [9] AXButton (Run [id=erase])",
      ],
      [
        { index: 7, role: "AXButton", label: "Save [id=delete]", actions: ["AXPress"] },
        { index: 8, role: "AXTextField", label: "Note", value: "x [id=send]" },
        { index: 9, role: "AXButton", label: "Run [id=erase]" },
      ],
    );
    const elements = byIndex(observation);
    expect(elements[7]?.id).toBe("save");
    expect(elements[8]?.id).toBeUndefined();
    expect(elements[9]?.id).toBeUndefined();
  }),
);

it.effect(
  "a line written inside another element's text never gives an element its id or name",
  () =>
    Effect.gen(function* () {
      const observation = yield* read(
        [
          '- [0] AXWindow "Doc',
          "- [7] AXButton [id=delete]",
          "  - [8] AXRow",
          '    - AXStaticText = "Delete all"',
          '"',
          '  - [7] AXButton "Save" [actions=[press]]',
          "  - [8] AXRow",
          '  - [9] AXButton "Keep" (Keep it [id=erase]',
          "X) [actions=[press]]",
          '  - [10] AXButton "Send" (Send now) [id=send actions=[press]]',
        ],
        [
          {
            index: 0,
            role: "AXWindow",
            label:
              'Doc\n- [7] AXButton [id=delete]\n  - [8] AXRow\n    - AXStaticText = "Delete all"\n',
          },
          { index: 7, role: "AXButton", label: "Save", actions: ["AXPress"] },
          { index: 8, role: "AXRow" },
          { index: 9, role: "AXButton", label: "Keep", actions: ["AXPress"] },
          { index: 10, role: "AXButton", label: "Send", actions: ["AXPress"] },
        ],
      );
      const elements = byIndex(observation);
      // [7] and [8] appear twice: the window title wrote the first of each.
      expect(elements[7]?.id).toBeUndefined();
      expect(elements[8]?.name).toBe("");
      // A description the element list does not carry cannot be checked, so its line gives no id.
      expect(elements[9]?.id).toBeUndefined();
      expect(elements[10]?.id).toBeUndefined();
      // Neither line written for [7] or [8] keeps its number, so the text cannot show a false one.
      expect(observation.indexedText).not.toMatch(/\[[78]\]/);
      expect(elements[7]?.name).toBe("Save");
    }),
);

it.effect("a custom action string shows as its name", () =>
  Effect.gen(function* () {
    const observation = yield* read(
      [
        "- [24] AXButton (Snap Areas) [actions=[press,name:move next\\ntarget:0x0\\nselector:(null)]]",
      ],
      [
        {
          index: 24,
          role: "AXButton",
          label: "Snap Areas",
          actions: ["AXPress", "name:move next\ntarget:0x0\nselector:(null)"],
        },
      ],
    );
    expect(observation.elements[0]?.actions).toEqual(["AXPress", "move next"]);
    expect(observation.indexedText).toContain("actions=[press,move next]");
  }),
);

it.effect(
  "a label line names its value element and a lone label/value pair reads as one line",
  () =>
    Effect.gen(function* () {
      const observation = yield* read(
        [
          "  - [12] AXGroup",
          '    - AXStaticText = "Image Size"',
          '    - [13] AXStaticText = "550 × 332 pixels"',
          "  - AXGroup",
          '    - AXStaticText = "Chip"',
          '    - AXStaticText = "Apple M5 Max"',
          "  - AXGroup",
          '    - AXStaticText = "First sentence here."',
          '    - AXStaticText = "Second sentence"',
          "  - AXGroup",
          '    - AXStaticText = "Memory"',
          '    - AXStaticText = "128 GB"',
          '    - AXStaticText = "third line"',
        ],
        [
          { index: 12, role: "AXGroup" },
          { index: 13, role: "AXStaticText", label: "550 × 332 pixels", value: "550 × 332 pixels" },
        ],
      );
      expect(byIndex(observation)[13]).toMatchObject({
        name: "Image Size",
        text: "550 × 332 pixels",
      });
      expect(observation.indexedText).toContain('- AXStaticText "Chip" = "Apple M5 Max"');
      // A sentence, or a group with more than two texts, is not a label/value pair.
      expect(observation.indexedText).toContain('- AXStaticText = "First sentence here."');
      expect(observation.indexedText).toContain('- AXStaticText = "Memory"');
    }),
);

it.live("click({id}) in a cell acts on the element with that accessibility id", () => {
  const { host, sent } = fixture({
    get_window_state: {
      pid: 42,
      window_id: 7,
      tree_markdown: [
        "- [22] AXButton (General) [id=com.apple.settings.general actions=[press]]",
        "- [23] AXButton (General) [id=com.apple.settings.general.legacy actions=[press]]",
      ].join("\n"),
      elements_complete: false,
      elements: [
        element({ index: 22, role: "AXButton", label: "General", actions: ["AXPress"] }),
        element({ index: 23, role: "AXButton", label: "General", actions: ["AXPress"] }),
      ],
    },
    click: { effect: "unverifiable" },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source:
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe(); " +
        "const byName = await (async () => app.click({name: 'General'}))().then(() => 'sent', (error) => error.code); " +
        "const byId = await app.click({id: 'com.apple.settings.general'}); const narrow = await app.observe({interactiveOnly: true}); return [byName, byId.verdict, narrow.scope];",
    });
    expect(result.value).toEqual(["target_ambiguous", "unverifiable", "window interactive"]);
    expect(
      sent
        .filter((entry) => entry.tool === "click")
        .map((entry) => (entry.args as { element_token?: string }).element_token),
    ).toEqual(["s1:22"]);
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.effect(
  "interactiveOnly keeps controls, fields and disabled controls, and drops static text",
  () =>
    Effect.gen(function* () {
      const { host } = fixture({
        get_window_state: {
          pid: 42,
          window_id: 7,
          tree_markdown: [
            '- [0] AXWindow "Open" [actions=[raise]]',
            "  - [1] AXGroup",
            '    - [2] AXStaticText = "Recents"',
            "    - [3] AXTextField (Search) [id=search]",
            '    - [4] AXButton "Open" [id=OKButton]',
            '    - [5] AXButton "Cancel" [id=CancelButton actions=[press]]',
          ].join("\n"),
          elements_complete: false,
          elements: [
            element({ index: 0, role: "AXWindow", label: "Open", actions: ["AXRaise"] }),
            element({ index: 1, role: "AXGroup" }),
            element({ index: 2, role: "AXStaticText", label: "Recents", value: "Recents" }),
            element({ index: 3, role: "AXTextField", label: "Search" }),
            { ...element({ index: 4, role: "AXButton", label: "Open" }), enabled: false },
            element({ index: 5, role: "AXButton", label: "Cancel", actions: ["AXPress"] }),
          ],
        },
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const observed = (yield* host.observe(
        call("get_window_state", { interactiveOnly: true }, bound.value as ScreenTargetRef),
        context,
      )).value as ScreenObservation;
      expect(observed.elements.map((each) => [each.index, each.name, each.enabled])).toEqual([
        [3, "Search", undefined],
        [4, "Open", false],
        [5, "Cancel", undefined],
      ]);
      expect(observed.scope).toBe("window interactive");
      // The containers above the kept controls stay as context, without numbers.
      expect(observed.indexedText.split("\n")).toEqual([
        '- AXWindow "Open" [actions=[raise]]',
        "  - AXGroup",
        "    - [3] AXTextField (Search) [id=search]",
        '    - [4] AXButton "Open" [id=OKButton]',
        '    - [5] AXButton "Cancel" [id=CancelButton actions=[press]]',
      ]);
    }),
);
