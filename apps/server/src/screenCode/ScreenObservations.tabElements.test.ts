import { describe, expect, it } from "@effect/vitest";
import type { PreviewAutomationSnapshot, ScreenObservation } from "@goat/contracts";
import { ScreenObservations } from "./ScreenObservations.ts";

const targetRef = {
  id: "tab-target",
  kind: "tab" as const,
  environmentId: "env",
  runId: "run",
  turnId: "turn",
  generation: 1,
};

const snapshot = (
  accessibilityTree: string,
  overrides: Partial<PreviewAutomationSnapshot> = {},
): PreviewAutomationSnapshot => ({
  url: "https://example.test/",
  title: "Example",
  loading: false,
  visibleText: "",
  interactiveElements: [],
  accessibilityTree,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  treeComplete: true,
  refGeneration: "1",
  ...overrides,
});

const observe = (
  observations: ScreenObservations,
  tree: string,
  options: {
    readonly overrides?: Partial<PreviewAutomationSnapshot>;
    readonly documentGeneration?: number;
    readonly base?: ScreenObservation;
    readonly treeBytes?: number;
  } = {},
) =>
  observations.renderObservation({
    draft: observations.normalizeTabSnapshot({
      targetRef,
      targetGeneration: 0,
      connectionId: "connection",
      controlGeneration: 1,
      ...(options.documentGeneration === undefined
        ? {}
        : { documentGeneration: options.documentGeneration }),
      snapshot: snapshot(tree, options.overrides),
    }),
    mode: options.base ? "diff" : "full",
    ...(options.base ? { baseObservationId: options.base.observationId } : {}),
    limits: { treeBytes: options.treeBytes ?? 64 * 1024 },
  });

const calculator = [
  "- generic [ref=e1]:",
  '  - button "CE" [ref=e2]',
  '  - button "7" [ref=e3]',
  '  - button "8" [ref=e4]',
  "  - iframe [ref=e5]",
].join("\n");

describe("tab observation elements", () => {
  it("a tab snapshot with an unread frame still offers its refs as numbered elements", () => {
    const observations = new ScreenObservations();
    const read = observe(observations, calculator, {
      overrides: { treeComplete: false, omitted: ["unread_frames"] },
      documentGeneration: 1,
    });
    expect(read).toMatchObject({ complete: false, truncated: true });
    expect(read.omitted).toContainEqual({ kind: "frames" });
    expect(read.elements.map((element) => [element.index, element.name])).toEqual([
      [0, ""],
      [1, "CE"],
      [2, "7"],
      [3, "8"],
      [4, ""],
    ]);
    expect(read.indexedText).toContain('button "CE" [1]');
    expect(observations.index.resolveElement(read.elements[1]!.ref)).toBe("aria-ref=e2");
  });

  it("refs from an incomplete tree stop resolving once a newer snapshot replaces it, and none are offered without a document", () => {
    const observations = new ScreenObservations();
    const first = observe(observations, calculator, {
      overrides: { treeComplete: false },
      documentGeneration: 1,
    });
    const ce = first.elements[1]!.ref;
    expect(observations.index.resolveElement(ce)).toBe("aria-ref=e2");
    observe(observations, calculator, {
      overrides: { treeComplete: false, refGeneration: "2" },
      documentGeneration: 1,
    });
    expect(observations.index.resolveElement(ce)).toBeUndefined();
    const unknownDocument = observe(new ScreenObservations(), calculator, {
      overrides: { treeComplete: false },
    });
    expect(unknownDocument.elements).toEqual([]);
  });

  it("a diff observation carries every current element, so a name found before is found again", () => {
    const observations = new ScreenObservations();
    const full = observe(observations, calculator);
    const diff = observe(observations, calculator.replace('"8"', '"9"'), { base: full });
    expect(diff.mode).toBe("diff");
    expect(diff.indexedText).toContain('+   - button "9" [3]');
    expect(diff.elements.map((element) => [element.index, element.name])).toEqual([
      [0, ""],
      [1, "CE"],
      [2, "7"],
      [3, "9"],
      [4, ""],
    ]);
  });

  it("every number shown in an over-budget tab observation has a ref, and the dropped ones are named", () => {
    const observations = new ScreenObservations();
    const tree = Array.from(
      { length: 1500 },
      (_, index) => `- button "Button number ${index}" [ref=e${index}]`,
    ).join("\n");
    const read = observe(observations, tree);
    expect(read.truncated).toBe(true);
    expect(read.elements.length).toBeGreaterThan(0);
    expect(read.elements.length).toBeLessThan(1500);
    const carried = new Set(read.elements.map((element) => element.index));
    const shown = [...read.indexedText.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    expect(shown.length).toBeGreaterThan(0);
    for (const number of shown) expect(carried.has(number)).toBe(true);
    const detail = read.omitted?.find((item) => item.kind === "budget")?.detail ?? "";
    expect(detail).toMatch(
      new RegExp(
        `^Left out ${1500 - read.elements.length} elements \\(\\[${read.elements.length}\\]–\\[1499\\]\\)`,
      ),
    );
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it("a paragraph, box or image named only by the text written under it is found by that text", () => {
    const observations = new ScreenObservations();
    const read = observe(
      observations,
      [
        "- paragraph [ref=e5]:",
        "  - text: Example Domain",
        "- img [ref=e6]:",
        "  - text: Company logo",
        "- generic [ref=e7]:",
        "  - text: Help text",
        '  - button "Go" [ref=e8]',
      ].join("\n"),
    );
    expect(read.elements.map((element) => [element.role, element.name])).toEqual([
      ["paragraph", "Example Domain"],
      ["img", "Company logo"],
      ["generic", ""],
      ["button", "Go"],
    ]);
  });

  it("a textbox or a field whose value is masked never takes its content as a name", () => {
    const observations = new ScreenObservations();
    const read = observe(
      observations,
      [
        "- textbox [ref=e1]:",
        "  - text: typed by the user",
        "- searchbox [ref=e2]:",
        "  - text: ••••••",
      ].join("\n"),
    );
    expect(read.elements.map((element) => element.name)).toEqual(["", ""]);
  });
});
