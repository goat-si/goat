import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  QuotaPool,
  type FleetSettings,
  type HostStatusEntry,
  type ModelSelection,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import payload from "../../usage/fixtures/opencodex-quota-pool.json" with { type: "json" };

import {
  hubTakesNoGoals,
  place,
  schedulerHostStatus,
  type PlacementInput,
} from "./placementRules.ts";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const LATER = "2026-10-20T05:00:00.000Z";
const EARLIER = "2026-10-19T20:00:00.000Z";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const opus: ModelSelection = { instanceId: codex, model: "anthropic/claude-opus-5-5" };
const claudeOpus: ModelSelection = { instanceId: claude, model: "claude-opus-5-5" };

const window = (usedPercent: number, resetsAt?: string) => ({
  id: "weekly",
  kind: "weekly" as const,
  label: "Weekly",
  usedPercent,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});
type Window = ReturnType<typeof window>;

const host = (
  name: string | null,
  options: {
    readonly running?: number;
    readonly queued?: number;
    readonly quotas?: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly windows: ReadonlyArray<Window>;
    }>;
    /** Omit for an older host, which lists only the instances that report quota. */
    readonly providers?: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly enabled: boolean;
    }>;
    readonly reachability?: HostStatusEntry["reachability"];
    readonly lastKnown?: true;
  } = {},
): HostStatusEntry => ({
  host: name,
  reachability: options.reachability ?? "ok",
  ...(options.lastKnown === undefined ? {} : { lastKnown: options.lastKnown }),
  metrics: {
    sampledAt: 0,
    cpuUtilization: 0,
    cpuCount: 8,
    availableMemoryBytes: 1,
    totalMemoryBytes: 2,
    loadAvg: null,
    disk: null,
    platform: "darwin",
    threads: { running: options.running ?? 0, waiting: 0, queued: options.queued ?? 0 },
    quotas: (options.quotas ?? [{ instanceId: codex, windows: [window(20)] }]).map((quota) => ({
      instanceId: quota.instanceId,
      driver: ProviderDriverKind.make("codex"),
      fromCache: true,
      limits: { checkedAt: EARLIER, windows: [...quota.windows] },
    })),
    ...(options.providers === undefined
      ? {}
      : {
          providers: options.providers.map((provider) => ({
            instanceId: provider.instanceId,
            driver: ProviderDriverKind.make("codex"),
            enabled: provider.enabled,
          })),
        }),
  },
});

const goal = (overrides: Partial<PlacementInput> = {}): PlacementInput => ({
  owner: "goal:g1",
  selections: [opus],
  hostSelector: {},
  avoidHosts: [],
  cordoned: new Set(),
  ...overrides,
});
const none: FleetSettings = {};
const pool = Schema.decodeUnknownSync(QuotaPool)(payload);

describe("place", () => {
  it("scores routed hosts from their raw pool while preserving direct account quota", () => {
    const routed = host("routed", { quotas: [{ instanceId: codex, windows: [window(1)] }] });
    const metrics = routed.metrics!;
    const pooled: HostStatusEntry = {
      ...routed,
      metrics: {
        ...metrics,
        quotaPool: pool,
        quotas: metrics.quotas.map((quota) => ({
          ...quota,
          limits: { ...quota.limits, quotaPool: { homeId: "fixture-home", provider: "openai" } },
        })),
      },
    };
    const result = place(
      goal(),
      [pooled, host("direct", { quotas: [{ instanceId: codex, windows: [window(50)] }] })],
      none,
      NOW,
    );
    assert.strictEqual(result._tag, "Placed");
    if (result._tag === "Placed") assert.strictEqual(result.host, "direct");
    assert.strictEqual(
      schedulerHostStatus(pooled, none, new Set(), 0, NOW).quotas[0]?.busiestPercent,
      61,
    );
  });
  it("skips a window at its limit until it resets and says when", () => {
    const result = place(
      goal(),
      [
        host(null, { quotas: [{ instanceId: codex, windows: [window(100, LATER)] }] }),
        host("mac-studio", { quotas: [{ instanceId: codex, windows: [window(70)] }] }),
      ],
      none,
      NOW,
    );
    assert.strictEqual(result._tag === "Placed" && result.host, "mac-studio");
    const refused = place(
      goal({ hostSelector: { hosts: [null] } }),
      [host(null, { quotas: [{ instanceId: codex, windows: [window(100, LATER)] }] })],
      none,
      NOW,
    );
    assert.deepStrictEqual(refused, {
      _tag: "Refused",
      reasons: [
        {
          host: null,
          reason: {
            code: "quota_exhausted",
            message: "codex is at its usage limit until " + LATER,
          },
        },
      ],
    });
  });

  it("treats a full window whose reset passed as open, and one without a reset as closed", () => {
    const passed = place(
      goal(),
      [host(null, { quotas: [{ instanceId: codex, windows: [window(100, EARLIER)] }] })],
      none,
      NOW,
    );
    assert.strictEqual(passed._tag, "Placed");
    const closed = place(
      goal(),
      [host(null, { quotas: [{ instanceId: codex, windows: [window(100)] }] })],
      none,
      NOW,
    );
    assert.strictEqual(closed._tag, "Refused");
  });

  it("refuses cordoned, stale, unreachable, capped and goal-free hosts with a reason each", () => {
    const settings: FleetSettings = {
      hosts: { local: { maxThreads: 2 }, macmini: { allowGoals: false } },
    };
    const result = place(
      goal({ cordoned: new Set(["mac-studio"]) }),
      [
        host(null, { running: 1, queued: 1 }),
        host("mac-studio"),
        host("macmini"),
        host("lidge-ai", { lastKnown: true }),
        host("mini", { reachability: "unreachable" }),
      ],
      settings,
      NOW,
    );
    assert.deepStrictEqual(
      result._tag === "Refused" && result.reasons.map((item) => [item.host, item.reason.code]),
      [
        [null, "host_cap"],
        ["mac-studio", "cordoned"],
        ["macmini", "goals_not_allowed"],
        ["lidge-ai", "not_ready"],
        ["mini", "not_ready"],
      ],
    );
  });

  it("keeps goal work off the hub but still places a person's own launch there", () => {
    const settings = hubTakesNoGoals({ hosts: { local: { maxThreads: 4 } } });
    const hosts = [host(null), host("mac-studio")];
    const goalWork = place(goal(), hosts, settings, NOW);
    assert.strictEqual(goalWork._tag === "Placed" && goalWork.host, "mac-studio");
    const own = place(
      goal({ owner: "thread:t1", hostSelector: { hosts: [null] } }),
      hosts,
      settings,
      NOW,
    );
    assert.strictEqual(own._tag === "Placed" && own.host, null);
    assert.deepStrictEqual(settings.hosts?.local, { maxThreads: 4, allowGoals: false });
  });

  it("refuses every host once the fleet holds its global limit of running plus queued threads", () => {
    const result = place(
      goal(),
      [host(null, { running: 1 }), host("mac-studio", { queued: 2 })],
      { maxRunningThreads: 3 },
      NOW,
    );
    assert.isTrue(
      result._tag === "Refused" &&
        result.reasons.every((item) => item.reason.code === "global_cap"),
    );
  });

  it("never refuses a person's own launch for a cap", () => {
    const result = place(
      goal({ owner: "thread:t1" }),
      [host(null, { running: 5 })],
      { maxRunningThreads: 1, hosts: { local: { maxThreads: 1, allowGoals: false } } },
      NOW,
    );
    assert.strictEqual(result._tag, "Placed");
  });

  it("honours the host selector and avoided hosts without listing them as refusals", () => {
    const hosts = [host(null), host("mac-studio"), host("macmini")];
    const result = place(
      goal({ hostSelector: { exclude: [null] }, avoidHosts: ["mac-studio"] }),
      hosts,
      none,
      NOW,
    );
    assert.strictEqual(result._tag === "Placed" && result.host, "macmini");
    const nothing = place(goal({ hostSelector: { hosts: ["lidge-ai"] } }), hosts, none, NOW);
    assert.deepStrictEqual(nothing, { _tag: "Refused", reasons: [] });
  });

  it("places on a chain step when the requested model's account is out, preferring the request on ties", () => {
    const quotas = [
      { instanceId: codex, windows: [window(100, LATER)] },
      { instanceId: claude, windows: [window(50)] },
    ];
    const fallen = place(
      goal({ selections: [opus, claudeOpus] }),
      [host(null, { quotas })],
      none,
      NOW,
    );
    assert.deepStrictEqual(fallen._tag === "Placed" && fallen.modelSelection, claudeOpus);
    const tie = place(
      goal({ selections: [opus, claudeOpus] }),
      [
        host(null, {
          quotas: [
            { instanceId: codex, windows: [window(30)] },
            { instanceId: claude, windows: [window(30)] },
          ],
        }),
      ],
      none,
      NOW,
    );
    assert.deepStrictEqual(tie._tag === "Placed" && tie.modelSelection, opus);
  });

  it("keeps work on the host whose environment holds its project", () => {
    const result = place(
      goal({ projectHost: "mac-studio" }),
      [host(null), host("mac-studio")],
      none,
      NOW,
    );
    assert.strictEqual(result._tag === "Placed" && result.host, "mac-studio");
    const refused = place(goal({ projectHost: "lidge-ai" }), [host(null)], none, NOW);
    assert.deepStrictEqual(refused._tag === "Refused" && refused.reasons[0]?.reason, {
      code: "no_project",
      message: "the project lives on lidge-ai",
    });
  });

  it("refuses an older host that does not report the requested instance", () => {
    const result = place(goal({ selections: [claudeOpus] }), [host(null)], none, NOW);
    assert.deepStrictEqual(result._tag === "Refused" && result.reasons[0]?.reason, {
      code: "no_instance",
      message: "claudeAgent is not configured there",
    });
  });

  it("places an instance listed in providers that reports no quota", () => {
    const result = place(
      goal({ selections: [claudeOpus] }),
      [host(null, { providers: [{ instanceId: claude, enabled: true }] })],
      none,
      NOW,
    );
    assert.strictEqual(result._tag, "Placed");
    assert.deepStrictEqual(result._tag === "Placed" && result.modelSelection, claudeOpus);
  });

  it("refuses an instance the host does not configure", () => {
    const result = place(
      goal({ selections: [claudeOpus] }),
      [host(null, { providers: [{ instanceId: codex, enabled: true }] })],
      none,
      NOW,
    );
    assert.deepStrictEqual(result._tag === "Refused" && result.reasons[0]?.reason, {
      code: "no_instance",
      message: "claudeAgent is not configured there",
    });
  });

  it("refuses an instance the host configures as disabled", () => {
    const result = place(
      goal({ selections: [claudeOpus] }),
      [
        host(null, {
          quotas: [{ instanceId: claude, windows: [window(10)] }],
          providers: [{ instanceId: claude, enabled: false }],
        }),
      ],
      none,
      NOW,
    );
    assert.deepStrictEqual(result._tag === "Refused" && result.reasons[0]?.reason, {
      code: "no_instance",
      message: "claudeAgent is disabled there",
    });
  });

  it("spreads work through choosePlacement's load penalty", () => {
    const result = place(
      goal(),
      [
        host(null, { running: 1, quotas: [{ instanceId: codex, windows: [window(10)] }] }),
        host("mac-studio", { quotas: [{ instanceId: codex, windows: [window(40)] }] }),
      ],
      none,
      NOW,
    );
    assert.strictEqual(result._tag === "Placed" && result.host, "mac-studio");
  });
});

describe("schedulerHostStatus", () => {
  it("reports counts against limits and the next reset of an exhausted window", () => {
    assert.deepStrictEqual(
      schedulerHostStatus(
        host("mac-studio", {
          running: 4,
          queued: 1,
          quotas: [{ instanceId: codex, windows: [window(100, LATER)] }],
        }),
        { hosts: { "mac-studio": { maxThreads: 5 } } },
        new Set(),
        5,
        NOW,
      ),
      {
        host: "mac-studio",
        reachability: "ok",
        running: 4,
        queued: 1,
        maxThreads: 5,
        allowGoals: true,
        quotas: [{ instanceId: codex, busiestPercent: 100, exhausted: true, resetsAt: LATER }],
        refusals: [{ code: "host_cap", message: "at its limit of 5 threads" }],
      },
    );
  });
});
