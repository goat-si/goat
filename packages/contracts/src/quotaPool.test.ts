import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { HostStatusMetrics } from "./hostStatus.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import {
  quotaWindowToUsageWindow,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "./providerUsageLimits.ts";
import { QuotaPool, QuotaWindow, type QuotaWindowKind } from "./quotaPool.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

const at = "2026-10-21T03:00:00.000Z";
const resetAt = "2026-10-21T08:00:00.000Z";
const burst = {
  id: "5h",
  kind: "burst_5h",
  label: "5 hours",
  usedPercent: 42,
  resetsAt: resetAt,
  windowSeconds: 18_000,
  source: "header",
  observedAt: at,
} satisfies QuotaWindow;

const pool = {
  schema: "ocx.quota-pool/1",
  producer: { version: "2.89.0", role: "hub", homeId: "home-fixture" },
  generatedAt: at,
  providers: [
    {
      provider: "openai",
      accounts: [
        {
          provider: "openai",
          driver: "codex",
          accountRef: "sha256:codex-fixture",
          label: "a***",
          plan: "pro",
          state: "available",
          windows: [
            burst,
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 60,
              source: "measured",
              observedAt: at,
            },
            {
              id: "credits",
              kind: "credits",
              label: "Credits",
              used: 12.5,
              limit: 100,
              unit: "usd",
              source: "measured",
              observedAt: at,
            },
          ],
        },
      ],
      pooled: { windows: [burst], headroom: 58, nextResetAt: resetAt },
    },
    {
      provider: "anthropic",
      accounts: [
        {
          provider: "anthropic",
          driver: "claudeAgent",
          accountRef: "sha256:anthropic-fixture",
          state: "exhausted",
          failure: "rate_limited",
          windows: [
            {
              id: "family:opus",
              kind: "weekly",
              label: "Opus weekly",
              usedPercent: 100,
              scopeModel: "family:opus",
              source: "measured",
              observedAt: at,
              exhausted: true,
            },
          ],
        },
      ],
      pooled: { windows: [] },
    },
    {
      provider: "kiro",
      accounts: [
        {
          provider: "kiro",
          accountRef: "sha256:kiro-fixture",
          state: "available",
          windows: [
            {
              id: "credits",
              kind: "credits",
              label: "Kiro credits",
              usedPercent: 25,
              used: 125,
              limit: 500,
              unit: "credits",
              source: "estimated",
              observedAt: at,
            },
          ],
        },
      ],
      pooled: { windows: [] },
    },
  ],
} satisfies QuotaPool;

// Frozen pre-quota-pool schemas: using the current window/source here would hide compatibility breaks.
const LegacyWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
const LegacyLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(LegacyWindow),
});
const LegacySources = ForwardCompatibleArray(
  Schema.Struct({
    id: UsageLimitSourceId,
    kind: Schema.Literal("cliproxy"),
    label: TrimmedNonEmptyString,
    checkedAt: IsoDateTime,
    accounts: ForwardCompatibleArray(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        driver: ProviderDriverKind,
        usageLimits: LegacyLimits,
      }),
    ),
  }),
);

const poolCodec = Schema.toCodecJson(QuotaPool);
const decodePool = Schema.decodeUnknownEffect(poolCodec);
const encodePool = Schema.encodeEffect(poolCodec);
const decodeWindow = Schema.decodeUnknownEffect(QuotaWindow);
const decodeUsageWindow = Schema.decodeUnknownEffect(ServerProviderUsageWindow);
const decodeLegacyWindow = Schema.decodeUnknownEffect(LegacyWindow);
const decodeSources = Schema.decodeUnknownEffect(UsageLimitSourceSnapshots);
const encodeSources = Schema.encodeEffect(Schema.toCodecJson(UsageLimitSourceSnapshots));
const decodeLegacySources = Schema.decodeUnknownEffect(LegacySources);
const metricsCodec = Schema.toCodecJson(HostStatusMetrics);
const decodeMetrics = Schema.decodeUnknownEffect(metricsCodec);
const encodeMetrics = Schema.encodeEffect(metricsCodec);

describe("QuotaPool", () => {
  it.effect("round-trips Codex, model-scoped Anthropic and Kiro credit evidence as JSON", () =>
    Effect.gen(function* () {
      const decoded = yield* decodePool(pool);
      const encoded = yield* encodePool(decoded);
      const wire = JSON.parse(JSON.stringify(encoded));
      expect(wire).toEqual(pool);
      expect(yield* decodePool(wire)).toEqual(pool);
    }),
  );

  it.effect(
    "drops unknown window kinds and account states without losing other pool evidence",
    () =>
      Effect.gen(function* () {
        const openai = pool.providers[0]!;
        const account = openai.accounts[0]!;
        const unknown = { ...burst, kind: "future_window" };
        const decoded = yield* decodePool({
          ...pool,
          providers: [
            {
              ...openai,
              accounts: [
                { ...account, windows: [unknown, ...account.windows] },
                { ...account, state: "future_state" },
              ],
              pooled: { ...openai.pooled, windows: [unknown, burst] },
            },
            { provider: "future-envelope", accounts: [], pooled: { kind: "future_pool" } },
            ...pool.providers.slice(1),
          ],
        });
        expect(decoded).toEqual(pool);
      }),
  );

  it.effect("accepts new provider and driver names and leaves account references opaque", () =>
    Effect.gen(function* () {
      const future = {
        provider: "future-provider",
        accounts: [
          {
            provider: "future-provider",
            driver: "future-driver",
            accountRef: " opaque:CaseSensitive/reference ",
            state: "unknown",
            windows: [],
          },
        ],
        pooled: { windows: [] },
      };
      const decoded = yield* decodePool({ ...pool, providers: [future] });
      expect(decoded.providers).toEqual([future]);
    }),
  );

  it.effect("keeps unknown percentages and missing windows absent", () =>
    Effect.gen(function* () {
      const decoded = yield* decodePool(pool);
      const credits = decoded.providers[0]!.accounts[0]!.windows[2]!;
      expect(credits).not.toHaveProperty("usedPercent");
      expect(credits).not.toHaveProperty("resetsAt");
      expect(decoded.providers[1]!.pooled.windows).toEqual([]);
      expect(quotaWindowToUsageWindow(credits)).toBeUndefined();
    }),
  );

  it.effect("rejects an unsupported wire version and invalid percentages", () =>
    Effect.gen(function* () {
      expect(
        yield* decodePool({ ...pool, schema: "ocx.quota-pool/2" }).pipe(Effect.isFailure),
      ).toBe(true);
      for (const usedPercent of [-1, 101]) {
        expect(yield* decodeWindow({ ...burst, usedPercent }).pipe(Effect.isFailure)).toBe(true);
      }
    }),
  );
});

describe("quota pool compatibility", () => {
  it.effect("decodes old usage windows and lets an old decoder ignore the added metadata", () =>
    Effect.gen(function* () {
      const legacy = { id: "5h", kind: "session", label: "5 hours", usedPercent: 42 };
      expect(yield* decodeUsageWindow(legacy)).toEqual(legacy);
      const mapped = quotaWindowToUsageWindow({ ...burst, scopeModel: "family:opus" });
      expect(yield* decodeLegacyWindow(mapped)).toEqual({
        ...legacy,
        resetsAt: resetAt,
        windowDurationMins: 300,
      });
    }),
  );

  it.effect("lets old ForwardCompatibleArray readers drop only the opencodex source", () =>
    Effect.gen(function* () {
      const legacy = {
        id: "legacy-source",
        kind: "cliproxy",
        label: "Legacy source",
        checkedAt: at,
        accounts: [
          {
            id: "opaque-fixture",
            driver: "codex",
            usageLimits: {
              checkedAt: at,
              windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 60 }],
            },
          },
        ],
      };
      const opencodex = { ...legacy, id: "opencodex-home", kind: "opencodex" };
      const current = yield* decodeSources([legacy, opencodex]);
      expect(current).toEqual([legacy, opencodex]);
      const wire = yield* encodeSources(current);
      expect(yield* decodeLegacySources(wire)).toEqual([legacy]);
    }),
  );

  it.effect("accepts old host metrics without a pool and round-trips metrics with a pool", () =>
    Effect.gen(function* () {
      const metrics = {
        sampledAt: 0,
        cpuUtilization: null,
        cpuCount: 8,
        availableMemoryBytes: 1024,
        totalMemoryBytes: 2048,
        loadAvg: null,
        disk: null,
        threads: { running: 0, waiting: 0, queued: 0 },
        quotas: [],
      };
      expect(yield* decodeMetrics(metrics)).toEqual(metrics);
      const withPool = { ...metrics, quotaPool: pool };
      const decoded = yield* decodeMetrics(withPool);
      expect(yield* encodeMetrics(decoded)).toEqual(withPool);
    }),
  );
});

describe("quotaWindowToUsageWindow", () => {
  const kinds = [
    ["burst_5h", "session"],
    ["weekly", "weekly"],
    ["monthly", "monthly"],
    ["daily", "other"],
    ["credits", "other"],
    ["custom", "other"],
  ] satisfies ReadonlyArray<readonly [QuotaWindowKind, ServerProviderUsageWindow["kind"]]>;

  it.effect.each(kinds)("maps %s to %s and preserves source and model scope", ([quotaKind, kind]) =>
    Effect.gen(function* () {
      const mapped = quotaWindowToUsageWindow({
        ...burst,
        kind: quotaKind,
        scopeModel: "family:opus",
      });
      expect(mapped).toEqual({
        id: "5h",
        kind,
        label: "5 hours",
        usedPercent: 42,
        resetsAt: resetAt,
        windowDurationMins: 300,
        quotaKind,
        source: "header",
        scopeModel: "family:opus",
      });
      expect(yield* decodeUsageWindow(mapped)).toEqual(mapped);
    }),
  );

  it.effect("preserves a measured zero without inventing reset, duration or model scope", () =>
    Effect.gen(function* () {
      const window = yield* decodeWindow({
        id: "custom:requests",
        kind: "custom",
        label: "Requests",
        usedPercent: 0,
        source: "estimated",
        observedAt: at,
      });
      expect(quotaWindowToUsageWindow(window)).toEqual({
        id: "custom:requests",
        kind: "other",
        label: "Requests",
        usedPercent: 0,
        quotaKind: "custom",
        source: "estimated",
      });
    }),
  );

  it.effect("rounds partial minutes up and preserves an explicitly reported zero duration", () =>
    Effect.sync(() => {
      expect(quotaWindowToUsageWindow({ ...burst, windowSeconds: 90 })?.windowDurationMins).toBe(2);
      expect(quotaWindowToUsageWindow({ ...burst, windowSeconds: 0 })?.windowDurationMins).toBe(0);
    }),
  );
});
