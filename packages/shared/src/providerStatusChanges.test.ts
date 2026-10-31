import type { ServerProvider } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyProviderStatusChanges, diffProviderStatuses } from "./providerStatusChanges.ts";

const provider = (instanceId: string, checkedAt: string, extra: Partial<ServerProvider> = {}) =>
  ({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [{ slug: instanceId + "-model", name: "Model", isCustom: false, capabilities: null }],
    slashCommands: [{ name: "review" }],
    skills: [{ name: "skill", path: "/skills/" + instanceId, enabled: true }],
    ...extra,
  }) as ServerProvider;

const roundTrip = (
  previous: ReadonlyArray<ServerProvider>,
  next: ReadonlyArray<ServerProvider>,
) => {
  const changes = diffProviderStatuses(previous, next);
  return changes === undefined ? previous : applyProviderStatusChanges(previous, changes);
};

describe("provider status changes", () => {
  it("a timestamp-only refresh sends that provider without its unchanged lists", () => {
    const before = [
      provider("codex", "2026-10-30T00:00:00.000Z"),
      provider("claude", "2026-10-30T00:00:00.000Z"),
    ];
    const after = [provider("codex", "2026-10-30T00:01:00.000Z"), before[1]!];

    const changes = diffProviderStatuses(before, after);

    expect(changes?.instanceIds).toEqual(["codex", "claude"]);
    expect(changes?.providers).toEqual([
      expect.objectContaining({ instanceId: "codex", checkedAt: "2026-10-30T00:01:00.000Z" }),
    ]);
    expect(changes?.providers[0]).not.toHaveProperty("skills");
    expect(changes?.providers[0]).not.toHaveProperty("models");
    expect(changes?.providers[0]).not.toHaveProperty("slashCommands");
    expect(roundTrip(before, after)).toEqual(after);
  });

  it("an unchanged list produces no change to send", () => {
    const list = [provider("codex", "2026-10-30T00:00:00.000Z")];
    expect(diffProviderStatuses(list, structuredClone(list))).toBeUndefined();
  });

  it("applying the changes rebuilds the next list exactly: added, removed, reordered, cleared fields, new skills", () => {
    const before = [
      provider("codex", "2026-10-30T00:00:00.000Z", { message: "Checking", status: "warning" }),
      provider("claude", "2026-10-30T00:00:00.000Z"),
      provider("cursor", "2026-10-30T00:00:00.000Z"),
    ];
    const after = [
      provider("cursor", "2026-10-30T00:00:00.000Z"),
      provider("codex", "2026-10-30T00:01:00.000Z", {
        skills: [{ name: "other", path: "/skills/other", enabled: true }],
      }),
      provider("grok", "2026-10-30T00:01:00.000Z"),
    ];

    expect(roundTrip(before, after)).toEqual(after);
    const changes = diffProviderStatuses(before, after);
    expect(changes?.providers.map((entry) => entry.instanceId)).toEqual(["codex", "grok"]);
    expect(changes?.providers[0]?.skills).toEqual(after[1]!.skills);
    expect(changes?.providers[0]).not.toHaveProperty("models");
  });

  it("keeps unchanged providers as the same objects so memoized views skip them", () => {
    const before = [
      provider("codex", "2026-10-30T00:00:00.000Z"),
      provider("claude", "2026-10-30T00:00:00.000Z"),
    ];
    const next = roundTrip(before, [provider("codex", "2026-10-30T00:01:00.000Z"), before[1]!]);
    expect(next[1]).toBe(before[1]);
    expect(next[0]?.skills).toBe(before[0]!.skills);
  });
});
