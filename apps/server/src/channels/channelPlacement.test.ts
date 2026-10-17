import { assert, describe, it } from "@effect/vitest";

import { choosePlacement, type PlacementCandidate } from "./channelPlacement.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const LATER = "2026-10-18T00:00:00.000Z";
const EARLIER = "2026-10-17T00:00:00.000Z";

const candidate = (
  value: string,
  overrides: Partial<PlacementCandidate<string>> = {},
): PlacementCandidate<string> => ({
  value,
  host: null,
  providerLabel: "Codex",
  preferred: false,
  windows: null,
  activeTasks: 0,
  ...overrides,
});

const weekly = (usedPercent: number, resetsAt?: string) => [
  { label: "Weekly", usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) },
];

describe("choosePlacement", () => {
  it("picks the host whose weekly quota has more room", () => {
    const placed = choosePlacement(
      [
        candidate("local", { preferred: true, windows: weekly(82) }),
        candidate("studio", { host: "mac-studio", windows: weekly(46) }),
      ],
      NOW,
    );
    assert.strictEqual(placed?.chosen.value, "studio");
    assert.strictEqual(placed?.reason, "mac-studio · Codex · 46% weekly used (vs 82% on Codex)");
  });

  it("spreads concurrent tasks across hosts through the load penalty", () => {
    const hosts = (loadOnStudio: number) => [
      candidate("local", { windows: weekly(50) }),
      candidate("studio", { host: "mac-studio", windows: weekly(30), activeTasks: loadOnStudio }),
    ];
    // The first task goes where quota is lowest; once it runs there, the next one goes elsewhere.
    assert.strictEqual(choosePlacement(hosts(0), NOW)?.chosen.value, "studio");
    const second = choosePlacement(hosts(1), NOW);
    assert.strictEqual(second?.chosen.value, "local");
    assert.strictEqual(second?.reason, "Codex · 50% weekly used · free while others work");
  });

  it("skips an account at its limit while a second subscription can run", () => {
    const placed = choosePlacement(
      [
        candidate("personal", {
          preferred: true,
          providerLabel: "Codex",
          windows: weekly(100, LATER),
        }),
        candidate("work", { providerLabel: "Codex (work)", windows: weekly(90) }),
      ],
      NOW,
    );
    assert.strictEqual(placed?.chosen.value, "work");
    assert.strictEqual(placed?.reason, "Codex (work) · 90% weekly used · Codex at usage limit");
  });

  it("says so when every candidate is at its limit, and keeps the configured one", () => {
    const placed = choosePlacement(
      [
        candidate("work", { providerLabel: "Codex (work)", windows: weekly(100, LATER) }),
        candidate("personal", { preferred: true, windows: weekly(100) }),
      ],
      NOW,
    );
    assert.strictEqual(placed?.chosen.value, "personal");
    assert.strictEqual(placed?.reason, "Codex · every candidate is at its usage limit");
    const alone = choosePlacement(
      [candidate("studio", { host: "mac-studio", windows: weekly(100, LATER) })],
      NOW,
    );
    assert.strictEqual(alone?.reason, "mac-studio · Codex · at its usage limit");
  });

  it("treats a full window whose reset time has passed as open", () => {
    const placed = choosePlacement(
      [
        candidate("stale", { preferred: true, windows: weekly(100, EARLIER) }),
        candidate("other", { providerLabel: "Codex (work)", windows: weekly(40) }),
      ],
      NOW,
    );
    // Not skipped, but its last report still scores it as full.
    assert.strictEqual(placed?.chosen.value, "other");
    assert.notInclude(placed?.reason ?? "", "usage limit");
  });

  it("keeps the configured candidate on a tie and stays quiet when nothing is reported", () => {
    const tie = choosePlacement(
      [candidate("other"), candidate("configured", { preferred: true })],
      NOW,
    );
    assert.strictEqual(tie?.chosen.value, "configured");
    assert.strictEqual(tie?.reason, undefined);
    // Moved by load alone: say why, even without quota.
    const moved = choosePlacement(
      [candidate("busy", { preferred: true, activeTasks: 1 }), candidate("idle")],
      NOW,
    );
    assert.strictEqual(moved?.chosen.value, "idle");
    assert.strictEqual(moved?.reason, "Codex · usage not reported · free while others work");
    const lone = choosePlacement([candidate("only", { preferred: true })], NOW);
    assert.strictEqual(lone?.chosen.value, "only");
    assert.strictEqual(lone?.reason, undefined);
    assert.strictEqual(choosePlacement([], NOW), undefined);
  });
});
