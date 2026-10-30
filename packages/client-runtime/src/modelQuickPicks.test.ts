import { describe, expect, it } from "vite-plus/test";
import { buildModelQuickPicks, recentModelKeys } from "./modelQuickPicks.ts";

const thread = (
  model: string,
  usedAt: string,
  overrides: Partial<Parameters<typeof recentModelKeys>[0][number]> = {},
) => ({
  environmentId: "env-a",
  modelSelection: { instanceId: "codex", model },
  latestUserMessageAt: usedAt,
  updatedAt: usedAt,
  archivedAt: null,
  ...overrides,
});

describe("recentModelKeys", () => {
  it("lists each model once, newest prompt first, for one environment's live threads", () => {
    const keys = recentModelKeys(
      [
        thread("sol", "2026-10-01T00:00:00Z"),
        thread("terra", "2026-10-03T00:00:00Z"),
        thread("sol", "2026-10-04T00:00:00Z"),
        thread("luna", "2026-10-05T00:00:00Z", { environmentId: "env-b" }),
        thread("astra", "2026-10-06T00:00:00Z", { archivedAt: "2026-10-07T00:00:00Z" }),
        thread("nova", "2026-10-06T00:00:00Z", { deletedAt: "2026-10-07T00:00:00Z" }),
        thread("idle", "2026-10-02T00:00:00Z", {
          latestUserMessageAt: null,
          updatedAt: "2026-10-08T00:00:00Z",
        }),
      ],
      "env-a",
      2,
    );
    expect(keys).toEqual(["codex:idle", "codex:sol"]);
  });
});

describe("buildModelQuickPicks", () => {
  const models = [
    { key: "codex:sol" },
    { key: "codex:terra" },
    { key: "codex:luna", isHidden: true },
    { key: "claude:opus" },
    { key: "claude:sonnet", isUnavailable: true },
    { key: "cursor:grok" },
  ];

  it("puts favorites in catalog order before recents and skips shown, hidden and unavailable models", () => {
    const picks = buildModelQuickPicks({
      models,
      excludeKeys: new Set(["codex:sol"]),
      favoriteKeys: new Set(["claude:opus", "codex:sol", "codex:luna", "codex:terra"]),
      recentKeys: ["claude:sonnet", "cursor:grok", "claude:opus", "codex:gone"],
      limit: 4,
    });
    expect(picks.map((pick) => [pick.model.key, pick.reason])).toEqual([
      ["codex:terra", "favorite"],
      ["claude:opus", "favorite"],
      ["cursor:grok", "recent"],
    ]);
  });

  it("stops at the limit", () => {
    const picks = buildModelQuickPicks({
      models,
      excludeKeys: new Set(),
      favoriteKeys: new Set(),
      recentKeys: ["cursor:grok", "codex:terra", "codex:sol"],
      limit: 2,
    });
    expect(picks.map((pick) => pick.model.key)).toEqual(["cursor:grok", "codex:terra"]);
  });
});
