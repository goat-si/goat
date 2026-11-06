import { expect, it } from "vite-plus/test";
import { boundSnapshotMetadata } from "./snapshotTransport.ts";

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
