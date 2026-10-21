import { assert, describe, it } from "@effect/vitest";
import { QuotaPool } from "@goat/contracts";
import * as Schema from "effect/Schema";
import payload from "../usage/fixtures/opencodex-quota-pool.json" with { type: "json" };

import {
  busiestWindow,
  choosePlacement,
  isExhausted,
  type PlacementCandidate,
} from "./channelPlacement.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const LATER = "2026-10-18T00:00:00.000Z";
const EARLIER = "2026-10-17T00:00:00.000Z";
const pool = Schema.decodeUnknownSync(QuotaPool)(payload);

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
  it("uses OpenCodex's pooled windows when it chooses the account", () => {
    const routed = candidate("routed", { windows: weekly(99), quotaPool: pool.providers[0] });
    assert.deepStrictEqual(busiestWindow(routed), { label: "5 hours", usedPercent: 61 });
    assert.strictEqual(
      choosePlacement([routed, candidate("direct", { windows: weekly(70) })], NOW)?.chosen.value,
      "routed",
    );
  });

  it("uses every window of the selected pool account without deriving pooled math", () => {
    const routed = candidate("account-a", {
      accountRef: "sha256:account-a",
      quotaPool: pool.providers[0],
    });
    assert.deepStrictEqual(busiestWindow(routed), { label: "5 hours", usedPercent: 95 });
    assert.strictEqual(
      choosePlacement([routed, candidate("direct", { windows: weekly(70) })], NOW)?.chosen.value,
      "direct",
    );
  });

  it("keeps a missing reading unknown, including a missing chosen account", () => {
    for (const accountRef of ["sha256:account-b", "missing"]) {
      const unknown = candidate("unknown", { accountRef, quotaPool: pool.providers[0] });
      assert.isNull(busiestWindow(unknown));
      assert.isFalse(isExhausted(unknown, NOW));
      assert.strictEqual(
        choosePlacement([unknown, candidate("known", { windows: weekly(10) })], NOW)?.chosen.value,
        "known",
      );
    }
  });

  it("gates only the proved model family on local and remote routes", () => {
    const scoped = candidate("routed", {
      quotaPool: pool.providers[1],
      model: "anthropic/claude-sonnet-4-6",
    });
    assert.isFalse(isExhausted(scoped, NOW));
    assert.deepStrictEqual(busiestWindow(scoped), { label: "5 hours", usedPercent: 20 });
    assert.isTrue(isExhausted({ ...scoped, model: "claude-opus-4-6" }, NOW));
    const legacy = {
      ...scoped,
      quotaPool: undefined,
      windows: [{ label: "Opus", usedPercent: 100, scopeModel: "family:opus" }],
    };
    assert.isFalse(isExhausted(legacy, NOW));
    assert.isTrue(isExhausted({ ...legacy, model: "claude-opus-4-6" }, NOW));
  });

  it("honors refusal evidence without fabricating an unknown percentage", () => {
    const provider = pool.providers[0]!;
    const routed = candidate("routed", {
      quotaPool: {
        ...provider,
        pooled: {
          windows: [
            {
              id: "blocked",
              kind: "custom",
              label: "Blocked",
              source: "header",
              observedAt: pool.generatedAt,
              exhausted: true,
            },
          ],
        },
      },
    });
    assert.isTrue(isExhausted(routed, NOW));
    const unknown = {
      ...routed,
      quotaPool: {
        ...provider,
        pooled: {
          windows: [
            {
              id: "unknown",
              kind: "credits" as const,
              label: "Credits",
              source: "measured" as const,
              observedAt: pool.generatedAt,
              used: 12,
              limit: 50,
            },
          ],
        },
      },
    };
    assert.isNull(busiestWindow(unknown));
  });
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
