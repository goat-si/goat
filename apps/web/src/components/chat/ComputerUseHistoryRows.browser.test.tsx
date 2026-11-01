import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { ComputerUseHistoryRows } from "./ComputerUseHistoryRows";

it("renders newest history first and includes the refusal code", async () => {
  const base = {
    threadId: "thread:a",
    recordedAt: 0,
    targetKind: "app",
    appId: "fixture.app",
    appName: "Fixture",
    tabHost: null,
    targetLabel: null,
    typedText: null,
    typedLength: null,
  } as const;
  const entries = [
    { ...base, id: 2, method: "click", verdict: "refused", refusalCode: "target_busy" },
    { ...base, id: 1, method: "type_text", verdict: "sent", refusalCode: null, typedLength: 6 },
  ] as const;
  await using screen = await render(<ComputerUseHistoryRows entries={entries} />);
  const rows = screen.getByRole("listitem").elements();
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("click");
  expect(rows[0]?.textContent).toContain("target_busy");
  expect(rows[1]?.textContent).toContain("type_text");
  expect(rows[1]?.textContent).toContain("6 characters");
});
