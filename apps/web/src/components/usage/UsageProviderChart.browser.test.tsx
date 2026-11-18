import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { DailyTotals } from "@goat/shared/usageMerge";

import { render } from "../../../test/render";
import { UsageProviderChart } from "./UsageProviderChart";
import { UsageShareBar } from "./UsageShareBar";

describe("usage visualizations", () => {
  it("exposes the chart amounts as labeled table cells and the share amounts as list items", async () => {
    const day = "2026-08-01";
    const daily = {
      day,
      costUsd: 4,
      totalTokens: 200,
      byProvider: new Map([
        ["claude", { costUsd: 3, totalTokens: 150 }],
        ["codex", { costUsd: 1, totalTokens: 50 }],
      ]),
    } satisfies DailyTotals;
    await using _screen = await render(
      <>
        <UsageProviderChart
          days={[day]}
          daily={[daily]}
          hours={[]}
          hourly={[]}
          providers={["claude", "codex"]}
          metric="cost"
          referenceTime={undefined}
          resolution="day"
          timeZone="UTC"
          hour12={false}
        />
        <UsageShareBar
          label="Provider cost"
          segments={[
            { label: "Claude Code", value: 3, color: "red" },
            { label: "Codex", value: 1, color: "blue" },
          ]}
          format={(value) => `$${value}`}
        />
      </>,
    );

    const table = page.getByRole("table", { name: "Daily cost by provider" });
    for (const name of ["Day", "Claude Code", "Codex", "Total"]) {
      await expect.element(table.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    const dayRow = table.getByRole("row").filter({ has: page.getByRole("rowheader") });
    for (const name of ["$3.00", "$1.00", "$4.00"]) {
      await expect.element(dayRow.getByRole("cell", { name })).toBeInTheDocument();
    }

    const legend = page.getByRole("list", { name: "Provider cost" });
    for (const [label, amount, percentage] of [
      ["Claude Code", "$3", ", 75.0%"],
      ["Codex", "$1", ", 25.0%"],
    ] as const) {
      const item = legend.getByRole("listitem").filter({ hasText: label });
      for (const text of [label, amount, percentage]) {
        await expect.element(item.getByText(text, { exact: true })).toBeInTheDocument();
      }
    }
  });
});
