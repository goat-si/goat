import { expect, it } from "vite-plus/test";
import { boundSnapshotMetadata, MAX_SNAPSHOT_TEXT_BYTES } from "./snapshotTransport.ts";

it("keeps surrogate pairs intact when bounding preview text and diagnostics", () => {
  const result = boundSnapshotMetadata({
    url: "https://example.test",
    title: `t${"😀".repeat(35_000)}`,
    visibleText: "",
    interactiveElements: [],
    consoleEntries: [{ level: "error", text: `x${"😀".repeat(35_000)}` }],
    networkEntries: [],
    actionTimeline: [],
  });
  const parsed = JSON.parse(result.text);
  expect(parsed.title.isWellFormed()).toBe(true);
  expect(parsed.title.length).toBe(2048);
  expect(parsed.consoleEntries[0].text.isWellFormed()).toBe(true);
  expect(parsed.consoleEntries[0].text.length).toBe(500);
});

it("sends elements only for refs past the delivered tree", () => {
  const ref = (index: number) => `t3-abcdef01-1-e${index}`;
  const lines = Array.from(
    { length: 1_500 },
    (_, index) => `- button "Button ${index}" [ref=${ref(index)}] [box=0,${index},80,20]`,
  );
  const elements = lines.map((_, index) => ({
    tag: "button",
    role: "button",
    name: `Button ${index}`,
    selector: `aria-ref=${ref(index)}`,
    x: 0,
    y: index,
    width: 80,
    height: 20,
  }));
  const snapshot = (tree: string, interactiveElements: typeof elements) => ({
    url: "https://example.test",
    title: "",
    visibleText: "",
    interactiveElements,
    accessibilityTree: tree,
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
  });
  const cut = boundSnapshotMetadata(snapshot(lines.join("\n"), elements));
  expect(Buffer.byteLength(cut.text, "utf8")).toBeLessThanOrEqual(MAX_SNAPSHOT_TEXT_BYTES);
  const parsed = JSON.parse(cut.text) as {
    readonly accessibilityTree: string;
    readonly interactiveElements: ReadonlyArray<{ readonly selector: string }>;
  };
  expect(parsed.interactiveElements.length).toBeGreaterThan(0);
  for (const element of parsed.interactiveElements)
    expect(parsed.accessibilityTree).not.toContain(
      `[ref=${element.selector.slice("aria-ref=".length)}]`,
    );
  const firstMissing = elements.find(
    (element) =>
      !parsed.accessibilityTree.includes(`[ref=${element.selector.slice("aria-ref=".length)}]`),
  );
  expect(firstMissing).toBeDefined();
  expect(parsed.interactiveElements[0]?.selector).toBe(firstMissing?.selector);
  const intact = JSON.parse(
    boundSnapshotMetadata(snapshot(lines.slice(0, 3).join("\n"), elements.slice(0, 3))).text,
  );
  expect(intact.interactiveElements).toEqual([]);
});
