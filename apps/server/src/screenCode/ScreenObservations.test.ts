import { expect, it } from "@effect/vitest";
import type { PreviewAutomationSnapshot } from "@goat/contracts";
import { ScreenObservations } from "./ScreenObservations.ts";

it("a new desktop observation invalidates the previous element reference", () => {
  const observations = new ScreenObservations();
  const draft = {
    targetRef: {
      id: "target",
      kind: "app" as const,
      environmentId: "env",
      runId: "run",
      turnId: "turn",
      generation: 1,
    },
    targetGeneration: 1,
    surfaceGeneration: 2,
    indexedText: "Save",
    complete: true,
    truncated: false,
    loading: false,
    elements: [{ role: "button", name: "Save", driverToken: "private-driver-token" }],
  };
  const first = observations.renderObservation({
    draft,
    mode: "full",
    limits: { treeBytes: 1024 },
  });
  const ref = first.elements[0]?.ref;
  expect(ref && observations.index.resolveElement(ref)).toBe("private-driver-token");
  const second = observations.renderObservation({
    draft,
    mode: "full",
    limits: { treeBytes: 1024 },
  });
  expect(ref && observations.index.resolveElement(ref)).toBeUndefined();
  expect(second.elements[0]?.ref.id).not.toBe(ref?.id);
  expect(JSON.stringify(second)).not.toContain("private-driver-token");
  expect(
    observations.index.putRegion("target", second.observationId, "region", {
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    }),
  ).toBe(true);
  expect(
    observations.index.resolvePoint({
      observationId: second.observationId,
      regionId: "region",
      x: 5,
      y: 5,
    }),
  ).toEqual({ targetId: "target", x: 5, y: 5 });
  expect(
    observations.index.resolvePoint({
      observationId: first.observationId,
      regionId: "region",
      x: 5,
      y: 5,
    }),
  ).toBeUndefined();
});

const tabDraft = (text: string, generation = 1) => ({
  targetRef: {
    id: "tab-target",
    kind: "tab" as const,
    environmentId: "env",
    runId: "run",
    turnId: "turn",
    generation: 0,
  },
  targetGeneration: 0,
  surfaceGeneration: generation,
  lineage: "connection:owner:origin",
  indexedText: text,
  complete: true,
  truncated: false,
  loading: false,
  elements: text
    .split("\n")
    .filter((line) => line.includes("[ref="))
    .map((line) => ({
      role: "button",
      name: line,
      driverToken: `aria-ref=${line.match(/\[ref=([^\]]+)\]/)?.[1] ?? ""}`,
    })),
});

it("opaque browser generations keep complete snapshots actionable", () => {
  const observations = new ScreenObservations();
  const snapshot: PreviewAutomationSnapshot = {
    url: "https://example.test/",
    title: "Workspace",
    loading: false,
    visibleText: "Save",
    interactiveElements: [],
    accessibilityTree: "- button Save [ref=e1]",
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    treeComplete: true,
    refGeneration: "ns-3",
  };
  const normalize = (value: PreviewAutomationSnapshot) =>
    observations.normalizeTabSnapshot({
      targetRef: tabDraft("").targetRef,
      targetGeneration: 0,
      connectionId: "connection",
      controlGeneration: 1,
      snapshot: value,
    });
  const first = observations.renderObservation({
    draft: normalize(snapshot),
    mode: "full",
    limits: { treeBytes: 4096 },
  });
  expect(first).toMatchObject({
    complete: true,
    truncated: false,
    title: snapshot.title,
    url: snapshot.url,
  });
  expect(first.elements).toHaveLength(1);
  expect(observations.index.resolveElement(first.elements[0]!.ref)).toBe("aria-ref=e1");
  const same = normalize(snapshot);
  const next = normalize({ ...snapshot, refGeneration: "other-1" });
  expect(same.surfaceGeneration).toBe(first.surfaceGeneration);
  expect(next.surfaceGeneration).toBeGreaterThan(first.surfaceGeneration);
  const missing = normalize({ ...snapshot, refGeneration: undefined });
  expect(missing).toMatchObject({ complete: false, truncated: true, elements: [] });
});

it("indexes only actionable refs in the current complete observation", () => {
  const observations = new ScreenObservations();
  const first = observations.renderObservation({
    draft: tabDraft("heading\nbutton [ref=a]"),
    mode: "full",
    limits: { treeBytes: 4096 },
  });
  expect(first.elements).toHaveLength(1);
  expect(observations.index.resolveElement(first.elements[0]!.ref)).toBe("aria-ref=a");
  observations.renderObservation({
    draft: tabDraft("button [ref=b]", 2),
    mode: "full",
    limits: { treeBytes: 4096 },
  });
  expect(observations.index.resolveElement(first.elements[0]!.ref)).toBeUndefined();
});

it("returns a diff only for consecutive complete same-lineage trees, carrying every current element", () => {
  const observations = new ScreenObservations();
  const base = observations.renderObservation({
    draft: tabDraft("heading\nbutton Save [ref=a]"),
    mode: "full",
    limits: { treeBytes: 4096 },
  });
  const diff = observations.renderObservation({
    draft: tabDraft("heading\nbutton Save [ref=a]\nbutton Cancel [ref=b]"),
    mode: "diff",
    baseObservationId: base.observationId,
    limits: { treeBytes: 4096 },
  });
  expect(diff.mode).toBe("diff");
  expect(diff.indexedText).toBe("+ button Cancel [1]");
  expect(diff.elements.map((element) => element.index)).toEqual([0, 1]);
  const reset = observations.renderObservation({
    draft: tabDraft("button [ref=c]", 3),
    mode: "diff",
    baseObservationId: base.observationId,
    limits: { treeBytes: 4096 },
  });
  expect(reset.mode).toBe("full");
  expect(reset.resetReason).toBeDefined();
});

it("rejects scaled points outside their region", () => {
  const observations = new ScreenObservations();
  const current = observations.renderObservation({
    draft: tabDraft("button [ref=a]"),
    mode: "full",
    limits: { treeBytes: 4096 },
  });
  observations.index.putRegion("tab-target", current.observationId, "region", {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    pixelWidth: 200,
    pixelHeight: 100,
    scale: 2,
  });
  expect(
    observations.index.resolvePoint({
      observationId: current.observationId,
      regionId: "region",
      x: 20,
      y: 40,
    }),
  ).toEqual({ targetId: "tab-target", x: 20, y: 40 });
  expect(
    observations.index.resolvePoint({
      observationId: current.observationId,
      regionId: "region",
      x: 200,
      y: 40,
    }),
  ).toBeUndefined();
});

it("query preserves ancestors and uses fresh numbering", () => {
  const observations = new ScreenObservations();
  const draft = tabDraft("- dialog Settings\n  - button Save [ref=a]\n  - button Cancel [ref=b]");
  const full = observations.renderObservation({ draft, mode: "full", limits: { treeBytes: 4096 } });
  const query = observations.renderObservation({
    draft,
    mode: "query",
    query: { name: "Save" },
    limits: { treeBytes: 4096 },
  });
  expect(query.indexedText).toContain("dialog Settings");
  expect(query.indexedText).not.toContain("Cancel");
  expect(query.elements).toHaveLength(1);
  expect(query.elements[0]?.index).toBe(0);
  expect(observations.index.resolveElement(full.elements[0]!.ref)).toBeUndefined();
});

it("query finds unreferenced text and preserves a focused child without indexing it", () => {
  const observations = new ScreenObservations();
  const draft = tabDraft(
    "- dialog Settings\n  - text: Welcome aboard\n  - textbox Search [active]\n  - button Save [ref=a]",
  );
  const query = observations.renderObservation({
    draft,
    mode: "query",
    query: { text: "Welcome aboard" },
    limits: { treeBytes: 4096 },
  });
  expect(query.indexedText).toContain("dialog Settings");
  expect(query.indexedText).toContain("text: Welcome aboard");
  expect(query.indexedText).toContain("textbox Search [active]");
  expect(query.indexedText).not.toContain("button Save");
  expect(query.elements).toHaveLength(0);
  expect(query.incompleteSearch).toBe(false);
});

it("evicting a target clears both its refs and diff base", () => {
  const observations = new ScreenObservations();
  const draft = tabDraft("- button Save [ref=a]");
  const first = observations.renderObservation({
    draft,
    mode: "full",
    limits: { treeBytes: 4096 },
  });
  observations.evictTarget(draft.targetRef.id);
  expect(observations.index.resolveElement(first.elements[0]!.ref)).toBeUndefined();
  const after = observations.renderObservation({
    draft,
    mode: "diff",
    baseObservationId: first.observationId,
    limits: { treeBytes: 4096 },
  });
  expect(after.mode).toBe("full");
  expect(after.resetReason).toBe("lineage_or_completeness_changed");
});

it("a Playwright-quoted tree line keeps its role, so its textbox is editable and found by role", () => {
  const observations = new ScreenObservations();
  const accessibilityTree =
    '- generic [active] [ref=e1]:\n  - \'textbox "Email: required" [ref=e2]\'\n  - button "Go" [ref=e3]';
  const draft = observations.normalizeTabSnapshot({
    targetRef: tabDraft("").targetRef,
    targetGeneration: 0,
    connectionId: "connection",
    controlGeneration: 1,
    snapshot: {
      url: "https://example.test/",
      title: "Page",
      loading: false,
      visibleText: "",
      interactiveElements: [],
      accessibilityTree,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      treeComplete: true,
      refGeneration: "1",
    },
  });
  const full = observations.renderObservation({ draft, mode: "full", limits: { treeBytes: 4096 } });
  const textbox = full.elements.find((element) => element.name.includes("Email: required"));
  expect(textbox?.role).toBe("textbox");
  expect(textbox && observations.index.isEditable(textbox.ref)).toBe(true);
  const query = observations.renderObservation({
    draft,
    mode: "query",
    query: { role: "textbox" },
    limits: { treeBytes: 4096 },
  });
  expect(query.elements.map((element) => element.role)).toEqual(["textbox"]);
});

it("a diff carries every current tab element with the role, name, text and state a full read gives", () => {
  const observations = new ScreenObservations();
  const form = (name: string, size: string, bacon: string) =>
    [
      "- generic [ref=e1]:",
      `  - textbox "Customer name:" [ref=e2] [box=117,16,147,22]${name}`,
      `  - radio "Small"${size} [ref=e3]`,
      `  - checkbox "Bacon"${bacon} [ref=e4]`,
      `  - 'textbox "Delivery time: HH:MM" [ref=e5]'${name ? ': "11:45"' : ""}`,
      '  - button "Submit \\"order\\"" [ref=e6] [cursor=pointer]',
      ...Array.from(
        { length: 24 },
        (_, line) => `  - paragraph: Unchanged form help, line ${line}`,
      ),
    ].join("\n");
  const read = (accessibilityTree: string, base?: string) =>
    observations.renderObservation({
      draft: observations.normalizeTabSnapshot({
        targetRef: tabDraft("").targetRef,
        targetGeneration: 0,
        connectionId: "connection",
        controlGeneration: 1,
        snapshot: {
          url: "https://httpbin.test/forms/post",
          title: "Form",
          loading: false,
          visibleText: "",
          interactiveElements: [],
          accessibilityTree,
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          treeComplete: true,
          refGeneration: "1",
        },
      }),
      mode: base ? "diff" : "full",
      ...(base ? { baseObservationId: base } : {}),
      limits: { treeBytes: 8192 },
    });
  const fields = (observation: ReturnType<typeof read>) =>
    observation.elements.map(({ role, name, text, selected }) => ({ role, name, text, selected }));
  const full = read(form("", "", ""));
  expect(fields(full)).toEqual([
    { role: "generic", name: "", text: undefined, selected: undefined },
    { role: "textbox", name: "Customer name:", text: undefined, selected: undefined },
    { role: "radio", name: "Small", text: undefined, selected: false },
    { role: "checkbox", name: "Bacon", text: undefined, selected: false },
    { role: "textbox", name: "Delivery time: HH:MM", text: undefined, selected: undefined },
    { role: "button", name: 'Submit "order"', text: undefined, selected: undefined },
  ]);
  const diff = read(form(": 홍길동 Test", " [checked]", " [checked]"), full.observationId);
  expect(diff.mode).toBe("diff");
  expect(fields(diff)).toEqual([
    { role: "generic", name: "", text: undefined, selected: undefined },
    { role: "textbox", name: "Customer name:", text: "홍길동 Test", selected: undefined },
    { role: "radio", name: "Small", text: undefined, selected: true },
    { role: "checkbox", name: "Bacon", text: undefined, selected: true },
    { role: "textbox", name: "Delivery time: HH:MM", text: "11:45", selected: undefined },
    { role: "button", name: 'Submit "order"', text: undefined, selected: undefined },
  ]);
});
it("a long element text keeps its start and its newest end within the same budget", () => {
  const observations = new ScreenObservations();
  const text = "start-" + "x".repeat(6000) + "-newest";
  const shown = observations.renderObservation({
    draft: {
      targetRef: {
        id: "target",
        kind: "app" as const,
        environmentId: "env",
        runId: "run",
        turnId: "turn",
        generation: 1,
      },
      targetGeneration: 1,
      surfaceGeneration: 1,
      indexedText: "- [0] AXTextArea",
      complete: true,
      truncated: false,
      loading: false,
      elements: [{ role: "AXTextArea", name: "", text, driverToken: "token" }],
    },
    mode: "full",
    limits: { treeBytes: 64 * 1024 },
  }).elements[0]?.text;
  expect(shown?.length).toBeLessThanOrEqual(4096);
  expect(shown?.startsWith("start-x")).toBe(true);
  expect(shown?.endsWith("x-newest")).toBe(true);
  expect(shown).toMatch(/…\[\d+ characters omitted\]…/);
});
it("a clipped text never splits a character and counts the characters it omits", () => {
  const observations = new ScreenObservations();
  for (const text of ["😀".repeat(6000), "a" + "😀".repeat(6000)]) {
    const shown =
      observations.renderObservation({
        draft: {
          targetRef: {
            id: "target",
            kind: "app" as const,
            environmentId: "env",
            runId: "run",
            turnId: "turn",
            generation: 1,
          },
          targetGeneration: 1,
          surfaceGeneration: 1,
          indexedText: "- [0] AXTextArea",
          complete: true,
          truncated: false,
          loading: false,
          elements: [{ role: "AXTextArea", name: "", text, driverToken: "token" }],
        },
        mode: "full",
        limits: { treeBytes: 64 * 1024 },
      }).elements[0]?.text ?? "";
    const marker = /…\[(\d+) characters omitted\]…/.exec(shown);
    expect(shown.length).toBeLessThanOrEqual(4096);
    expect(shown.isWellFormed()).toBe(true);
    expect(Number(marker?.[1]) + [...shown].length - [...(marker?.[0] ?? "")].length).toBe(
      [...text].length,
    );
  }
});

it("budget cuts remove current diff numbers but preserve removed old numbers", () => {
  const observations = new ScreenObservations();
  const draft = {
    targetRef: {
      id: "app-diff",
      kind: "app" as const,
      environmentId: "env",
      runId: "run",
      turnId: "turn",
      generation: 1,
    },
    targetGeneration: 1,
    surfaceGeneration: 1,
    complete: true,
    truncated: false,
    loading: false,
    indexedText: '+ [39] AXButton "Added"\n~ [38] AXButton "Changed"\n- [39] AXButton "Removed"',
    elements: Array.from({ length: 40 }, (_, index) => ({
      index,
      role: "AXButton",
      name: `Button ${index} ${"x".repeat(40)}`,
      driverToken: `s2:${index}`,
    })),
  };
  const result = observations.renderObservation({
    draft,
    mode: "diff",
    prediffed: true,
    baseObservationId: "old",
    limits: { treeBytes: 2500 },
  });
  expect(result.truncated).toBe(true);
  expect(result.elements.some((element) => element.index === 39 || element.index === 38)).toBe(
    false,
  );
  expect(result.indexedText).toContain('+ AXButton "Added"');
  expect(result.indexedText).toContain('~ AXButton "Changed"');
  expect(result.indexedText).toContain('- [39] AXButton "Removed"');
});
