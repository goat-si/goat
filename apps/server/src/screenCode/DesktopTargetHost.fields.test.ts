import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ScreenObservation, type ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

const decode = Schema.decodeUnknownSync(ScreenObservation);

const element = (index: number, role: string, label: string, extra: object = {}) => ({
  role,
  depth: 1,
  element_index: index,
  element_token: `s1:${index}`,
  label,
  ...extra,
});

const windowState = (extra: object, elements: ReadonlyArray<object>) => ({
  pid: 42,
  window_id: 7,
  snapshot_id: "s1",
  elements_complete: true,
  tree_markdown: elements
    .map((entry) => {
      const { element_index, role, label } = entry as {
        element_index: number;
        role: string;
        label: string;
      };
      return `- [${element_index}] ${role} ${JSON.stringify(label)}`;
    })
    .join("\n"),
  elements,
  ...extra,
});

const observe = (state: object, limits = context.limits) =>
  Effect.gen(function* () {
    const { host } = fixture({ get_window_state: state });
    const ref = (yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    )).value as ScreenTargetRef;
    const read = (args: object) =>
      host.observe(call("get_window_state", args, ref), { ...context, limits });
    return { first: (yield* read({})).value as ScreenObservation, read };
  });

it.effect(
  "observe keeps the driver's focus, selection, value description and urls, and the contract accepts them",
  () =>
    Effect.gen(function* () {
      const { first } = yield* observe(
        windowState({ window_title: "Notes", url: "file:///Users/me/notes.txt" }, [
          element(0, "AXTextArea", "Body", {
            value: "hello world",
            focused: true,
            selected_text: "world",
            selected_text_range: { location: 6, length: 5, units: "utf16" },
          }),
          element(1, "AXTextField", "Name", {
            value: "ab",
            selected_text: "",
            selected_text_range: { location: 2, length: 0, units: "utf16" },
          }),
          element(2, "AXSlider", "Volume", { value: "8", value_description: "8 dB" }),
          element(3, "AXRow", "notes.txt", { url: "file:///Users/me/notes.txt" }),
          element(4, "AXTextField", "Odd", {
            selected_text_range: { location: 1, length: 1, units: "bytes" },
          }),
        ]),
      );
      expect(decode(first)).toEqual(first);
      expect(first).toMatchObject({ title: "Notes", url: "file:///Users/me/notes.txt" });
      const byIndex = new Map(first.elements.map((each) => [each.index, each]));
      expect(byIndex.get(0)).toMatchObject({
        focused: true,
        selectedText: "world",
        selectedTextRange: { location: 6, length: 5 },
      });
      // A caret is an empty selection, not a missing one.
      expect(byIndex.get(1)).toMatchObject({
        selectedText: "",
        selectedTextRange: { location: 2, length: 0 },
      });
      expect(byIndex.get(2)).toMatchObject({ valueDescription: "8 dB" });
      expect(byIndex.get(3)).toMatchObject({ url: "file:///Users/me/notes.txt" });
      expect(byIndex.get(4)).not.toHaveProperty("selectedTextRange");
      expect(byIndex.get(2)).not.toHaveProperty("focused");
    }),
);

it.effect(
  "a window url that does not fit the read's budget goes before any element, and later pages carry none",
  () =>
    Effect.gen(function* () {
      const url = "https://example.test/" + "a".repeat(9000);
      const tight = yield* observe(
        windowState({ url }, [element(0, "AXButton", "Apply")]),
        screenRunLimits({ treeBytes: 1024 }),
      );
      expect(decode(tight.first)).toEqual(tight.first);
      expect(tight.first).not.toHaveProperty("url");
      expect(tight.first.truncated).toBe(true);
      expect(tight.first.elements.map((each) => each.name)).toEqual(["Apply"]);

      const many = Array.from({ length: 60 }, (_, index) =>
        element(index, "AXButton", `Button number ${index}`),
      );
      const paged = yield* observe(
        windowState({ url: "https://example.test/page" }, many),
        screenRunLimits({ treeBytes: 4096 }),
      );
      // A read its budget cut gave up its url before any element, so its pages carry none either.
      expect(paged.first.elements.length).toBeLessThan(60);
      expect(paged.first).not.toHaveProperty("url");
      const next = (yield* paged.read({
        after: paged.first.elements.length,
        baseObservationId: paged.first.observationId,
      })).value as ScreenObservation;
      expect(next.elements.length).toBeGreaterThan(0);
      expect(next).not.toHaveProperty("url");
    }),
);
