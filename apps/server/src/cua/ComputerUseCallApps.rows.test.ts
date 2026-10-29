import { OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { makeCallApps } from "./ComputerUseCallApps.ts";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const at = DateTime.makeUnsafe("2026-10-29T00:00:00.000Z");
type DynamicToolItem = Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>;

const cellRow = (
  input: unknown,
  output?: unknown,
  overrides: Partial<DynamicToolItem> = {},
): DynamicToolItem => ({
  id: TurnItemId.make("cell-row"),
  type: "dynamic_tool",
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: output === undefined ? "running" : "completed",
  title: "goat screen run",
  toolName: "goat.goat_screen_run",
  input,
  ...(output === undefined ? {} : { output }),
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  ...overrides,
});
const result = {
  runId: "run-1",
  turnId: "turn-1",
  cellId: "cell-1",
  status: "completed",
  console: [],
  journal: [],
  truncated: [],
  availability: [],
  imageMetadata: [],
};
const row = { title: "Terminal · type, press Enter", summary: "2 confirmed · 820 ms" };
const withRow = () => {
  const apps = makeCallApps();
  apps.screenRow("cell-1", { threadId: "thread-1", ...row }, 1_000);
  return apps;
};

describe("screen cell rows", () => {
  it("titles a row as its agent named the cell, while it runs and after, in each argument envelope", () => {
    const apps = makeCallApps();
    for (const input of [
      { code: "...", title: " Terminal: run the tests " },
      {
        server: "goat",
        tool: "goat_screen_run",
        arguments: { code: "...", title: "Terminal: run the tests" },
      },
    ]) {
      expect(apps.present(cellRow(input)).title).toBe("Terminal: run the tests");
      expect(apps.present(cellRow(input, "Ran the cell.")).title).toBe("Terminal: run the tests");
    }
    // A title that isn't one line of at most 80 characters is not the agent's row title.
    for (const title of ["two\nlines", "x".repeat(81)]) {
      const item = cellRow({ code: "...", title });
      expect(apps.present(item)).toBe(item);
    }
  });

  it("shows the server's row for the cell its own output names, in every provider's shape", () => {
    const apps = withRow();
    const error = {
      code: "unknown_outcome",
      effectStarted: true,
      nextStep: "Observe again.",
      cellId: "cell-1",
    };
    for (const output of [
      result,
      { content: [{ type: "image", data: "", mimeType: "image/png" }], structuredContent: result },
      [
        { type: "text", text: "// goat_screen_run cell API" },
        { type: "text", text: JSON.stringify(result) },
      ],
      { content: [{ text: { text: JSON.stringify(result) } }] },
      `// goat_screen_run cell API\n${JSON.stringify(result)}`,
      [{ type: "content", content: { type: "text", text: JSON.stringify(result) } }],
      [{ type: "text", text: JSON.stringify(error) }],
    ]) {
      const presented = decodeTurnItem(apps.present(cellRow({ code: "..." }, output), 2_000));
      expect(presented.title).toBe(row.title);
      expect(presented.type === "dynamic_tool" ? presented.toolSummary : undefined).toBe(
        row.summary,
      );
    }
    // The agent's own title wins over the server's.
    expect(apps.present(cellRow({ code: "...", title: "Mine" }, result), 2_000).title).toBe("Mine");
  });

  it("never shows text from a row's output, nor another thread's row, nor an expired one", () => {
    const apps = withRow();
    for (const item of [
      // A provider summary shaped like an error, with its own text and an unknown cell.
      cellRow(
        { code: "..." },
        { code: "stopped", effectStarted: false, nextStep: "x", cellId: "cell-9", title: "SECRET" },
      ),
      // A cell's own return value is nested and can't name a cell.
      cellRow({ code: "..." }, { ...result, cellId: undefined, value: { cellId: "cell-1" } }),
      cellRow({ code: "..." }, result, { threadId: ThreadId.make("thread-2") }),
      cellRow({ code: "..." }, "Ran the cell."),
    ])
      expect(apps.present(item, 2_000)).toBe(item);
    const late = cellRow({ code: "..." }, result);
    expect(apps.present(late, 1_000 + 15 * 60_000)).toBe(late);
    // Residual: a live cell id echoed on another row of the same thread shows that cell's row.
    expect(
      apps.present(cellRow({ code: "other" }, result, { id: TurnItemId.make("other-row") }), 2_000)
        .title,
    ).toBe(row.title);
  });

  it("keeps a resolved row's title and summary through updates that resolve nothing", () => {
    const apps = withRow();
    const stored = apps.present(cellRow({ code: "..." }, result), 2_000);
    for (const next of [
      cellRow({ code: "..." }, "Ran the cell."),
      cellRow({ code: "..." }, undefined, { status: "running" }),
      cellRow({ code: "..." }, undefined, { status: "pending" }),
    ]) {
      const presented = makeCallApps().present(next, 2_000);
      expect(apps.unresolvedScreenRow(presented)).toBe(true);
      const kept = apps.keepStoredScreenRow(presented, stored);
      expect(kept.title).toBe(row.title);
      expect(kept.type === "dynamic_tool" ? kept.toolSummary : undefined).toBe(row.summary);
    }
    // A fresh row has no resolved row stored, and a resolved update stands as it is.
    const fresh = cellRow({ code: "..." });
    expect(apps.keepStoredScreenRow(fresh, null)).toBe(fresh);
    expect(apps.keepStoredScreenRow(fresh, cellRow({ code: "..." }))).toBe(fresh);
    expect(apps.unresolvedScreenRow(stored)).toBe(false);
  });

  it("names the subjects a cell's own calls touched, apart from any other cell", () => {
    const apps = makeCallApps();
    const cell = { runId: "run-1", turnId: "turn-1", cellId: "cell-1" };
    const other = { ...cell, cellId: "cell-2" };
    apps.screenTarget("calc", {
      kind: "app",
      bundleId: "com.apple.calculator",
      name: "Calculator",
    });
    apps.screenTarget("tab-1", { kind: "tab", pageUrl: "https://www.example.com/" }, cell);
    for (let index = 0; index < 10; index++)
      apps.screenTarget("tab-1", { kind: "tab", pageUrl: "https://news.example.org/a" }, cell);
    apps.screenTarget("tab-2", { kind: "tab", pageUrl: "https://en.wikipedia.org/" }, other);
    expect(apps.takeCellSubjects(cell, ["tab-1", "calc"])).toEqual([
      "example.com",
      "example.org",
      "Calculator",
    ]);
    expect(apps.takeCellSubjects(other, ["tab-2"])).toEqual(["wikipedia.org"]);
    const many = { ...cell, cellId: "cell-3" };
    for (let index = 0; index < 20; index++)
      apps.screenTarget("tab-1", { kind: "tab", pageUrl: `https://site${index}.com/` }, many);
    const subjects = apps.takeCellSubjects(many, ["tab-1"]);
    expect(subjects).toHaveLength(20);
    expect(subjects.slice(0, 2)).toEqual(["site0.com", "site1.com"]);
  });
});
