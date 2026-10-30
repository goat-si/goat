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
    expect(diff.indexedText).toContain('+   - button "9" [5]');
    expect(diff.elements.map((element) => [element.index, element.name])).toEqual([
      [0, ""],
      [1, "CE"],
      [2, "7"],
      [5, "9"],
      [4, ""],
    ]);
  });

  it("diffs changed values, additions and removals by role, name and ref", () => {
    const observations = new ScreenObservations();
    const first = observe(
      observations,
      [
        '- textbox "Name" [ref=e1]: A',
        '- button "Same" [ref=e2]',
        '- button "Same" [ref=e3]',
        '- button "Remove" [ref=e4]',
      ].join("\n"),
    );
    const second = observe(
      observations,
      [
        '- textbox "Name" [ref=e1]: AB',
        '- button "Same" [ref=e3]',
        '- button "Same" [ref=e2]',
        '- button "Add" [ref=e5]',
      ].join("\n"),
      { base: first },
    );
    expect(second.mode).toBe("diff");
    expect(second.indexedText.split("\n")).toEqual([
      '- - button "Remove" [3]',
      '~ - textbox "Name" [0]: AB',
      '+ - button "Add" [4]',
    ]);
    for (const [number, token] of [
      [0, "e1"],
      [1, "e2"],
      [2, "e3"],
      [4, "e5"],
    ] as const) {
      const element = second.elements.find((entry) => entry.index === number);
      expect(element && observations.index.resolveElement(element.ref)).toBe(`aria-ref=${token}`);
    }
  });

  it("reports one changed row when a field receives one character", () => {
    const observations = new ScreenObservations();
    const first = observe(observations, '- textbox "Name" [ref=e1]: A\n- button "Save" [ref=e2]');
    const second = observe(
      observations,
      '- textbox "Name" [ref=e1]: AB\n- button "Save" [ref=e2]',
      { base: first },
    );
    expect(second.mode).toBe("diff");
    expect(second.indexedText).toBe('~ - textbox "Name" [0]: AB');
  });

  it("does not resend reordered siblings or duplicate names", () => {
    const observations = new ScreenObservations();
    const first = observe(observations, '- button "Same" [ref=e1]\n- button "Same" [ref=e2]');
    const second = observe(observations, '- button "Same" [ref=e2]\n- button "Same" [ref=e1]', {
      base: first,
    });
    expect(second.mode).toBe("diff");
    expect(second.indexedText).toBe(`no change since ${first.observationId}`);
    expect(observations.index.resolveElement(second.elements.find((e) => e.index === 0)!.ref)).toBe(
      "aria-ref=e1",
    );
  });

  it("resets when the surface generation changes even if refs are reused", () => {
    const observations = new ScreenObservations();
    const first = observe(observations, '- button "Save" [ref=e1]', {
      documentGeneration: 1,
    });
    const second = observe(observations, '- button "Save" [ref=e1]', {
      base: first,
      documentGeneration: 1,
      overrides: { refGeneration: "2" },
    });
    expect(second.surfaceGeneration).not.toBe(first.surfaceGeneration);
    expect(second).toMatchObject({ mode: "full", resetReason: "surface_generation_changed" });
    expect(second.indexedText).toBe('- button "Save" [0]');
    expect(observations.index.resolveElement(first.elements[0]!.ref)).toBeUndefined();
    expect(observations.index.resolveElement(second.elements[0]!.ref)).toBe("aria-ref=e1");
  });

  it("resets the diff after a document or completeness change", () => {
    const observations = new ScreenObservations();
    const first = observe(observations, calculator, { documentGeneration: 1 });
    const second = observe(observations, calculator, { base: first, documentGeneration: 2 });
    expect(second).toMatchObject({ mode: "full", resetReason: "lineage_or_completeness_changed" });
    const third = observe(observations, calculator, {
      base: second,
      documentGeneration: 2,
      overrides: { treeComplete: false },
    });
    expect(third).toMatchObject({ mode: "full", resetReason: "lineage_or_completeness_changed" });
  });

  it("returns a full read when a new document reuses a native ref", () => {
    const observations = new ScreenObservations();
    const first = observe(observations, '- button "Save" [ref=t3-1-e1]', {
      documentGeneration: 1,
    });
    const second = observe(observations, '- button "Save" [ref=t3-2-e1]', {
      base: first,
      documentGeneration: 2,
      overrides: { refGeneration: "2" },
    });
    expect(second).toMatchObject({ mode: "full", resetReason: "lineage_or_completeness_changed" });
    expect(second.indexedText).toBe('- button "Save" [0]');
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
