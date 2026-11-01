import { expect, it } from "vite-plus/test";
import { historyRows } from "./computerUseHistory.ts";

it("keeps newest-first history and exposes refusal codes and redacted lengths", () => {
  const base = {
    threadId: "thread:a",
    recordedAt: 0,
    targetKind: "app",
    appId: "fixture.app",
    appName: "Fixture",
    tabHost: null,
    targetLabel: "button: Save",
    typedText: null,
    typedLength: null,
  } as const;
  const rows = historyRows([
    { ...base, id: 2, method: "click", verdict: "refused", refusalCode: "target_busy" },
    { ...base, id: 1, method: "type_text", verdict: "sent", refusalCode: null, typedLength: 6 },
  ]);
  expect(rows.map((row) => row.id)).toEqual([2, 1]);
  expect(rows[0]?.target).toBe("Fixture (fixture.app)");
  expect(rows[0]?.refusal).toBe("target_busy");
  expect(rows[1]?.typed).toBe("6 characters");
});
