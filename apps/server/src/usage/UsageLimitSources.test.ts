import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
      Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Path.layer,
    ]),
    Effect.scoped,
  ),
);

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
it.effect("keeps a refused account's last reading within its hub and login", () => {
  const sourceId = UsageLimitSourceId.make("hub");
  const config = {
    kind: "cliproxy",
    url: "http://hub.test:8317/team-a",
    managementKey: "management-secret",
    enabled: true,
  } as const;
  let refused = true;
  let workspace: string | undefined = "login-a";
  let percent = 78;
  let onFailedRedemption: Effect.Effect<void> | undefined;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/auth-files")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: [
              {
                id: "first.json",
                auth_index: "a",
                provider: "codex",
                ...(workspace
                  ? { email: "first@example.com", id_token: { chatgpt_account_id: workspace } }
                  : {}),
              },
            ],
          }),
        );
      }
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      if (path.endsWith("/reset-quota")) {
        return HttpClientResponse.fromWeb(request, Response.json({}));
      }
      if (body.includes("/consume")) {
        refused = true;
        if (onFailedRedemption) {
          yield* onFailedRedemption;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ status_code: 502, body: "{}" }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ status_code: 200, body: JSON.stringify({ code: "reset" }) }),
        );
      }
      if (body.includes("/rate-limit-reset-credits")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            status_code: 200,
            body: JSON.stringify({
              credits: [
                {
                  id: "credit",
                  expires_at: "2099-01-01T00:00:00Z",
                  status: "available",
                  reset_type: "codex_rate_limits",
                },
              ],
            }),
          }),
        );
      }
      const usage = {
        plan_type: "pro",
        rate_limit: {
          secondary_window: {
            used_percent: percent,
            reset_at: 4070908800,
            limit_window_seconds: 604800,
          },
        },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          refused
            ? { status_code: 429, body: "{}" }
            : { status_code: 200, body: JSON.stringify(usage) },
        ),
      );
    }),
  );
  const unreadable = { windows: [], unavailable: { reason: "probeFailed" } };
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const sources = yield* UsageLimitSources.make;
    const settings = yield* ServerSettings.ServerSettingsService;
    const read = Effect.gen(function* () {
      yield* sources.refresh;
      return (yield* sources.current).find((source) => source.id === sourceId);
    });

    expect((yield* read)?.accounts[0]?.usageLimits).toMatchObject(unreadable);
    refused = false;
    expect((yield* read)?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(78);
    percent = 100;
    yield* TestClock.adjust("1 minute");
    const latest = (yield* read)?.accounts[0]?.usageLimits;
    yield* TestClock.adjust("1 minute");
    refused = true;
    const stale = yield* read;
    expect(stale?.accounts[0]?.usageLimits).toEqual(latest);
    expect(stale?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(100);
    expect(stale?.error).toContain("The hub could not read this account's usage.");
    if (stale) {
      expect(
        UsageLimitSources.hubPoolResetAt([stale], ProviderDriverKind.make("codex"), null, NOW),
      ).toBeNull();
    }
    expect((yield* read)?.accounts[0]?.usageLimits).toEqual(latest);

    // The same source ID and origin can point at another hub under a new path.
    yield* settings.updateSettings({
      usageLimitSources: {
        [sourceId]: { ...config, url: "http://hub.test:8317/team-b" },
      },
    });
    expect((yield* read)?.accounts[0]?.usageLimits).toMatchObject(unreadable);
    refused = false;
    yield* read;
    refused = true;
    workspace = "login-b";
    expect((yield* read)?.accounts[0]?.usageLimits).toMatchObject(unreadable);

    workspace = undefined;
    refused = false;
    yield* read;
    refused = true;
    expect((yield* read)?.accounts[0]?.usageLimits).toMatchObject(unreadable);

    workspace = "login-b";
    refused = false;
    yield* read;
    expect(
      yield* sources.consumeResetCredit({ sourceId, accountId: "first.json", creditId: "credit" }),
    ).toEqual({ outcome: "reset" });
    expect((yield* sources.current)[0]?.accounts[0]?.usageLimits).toMatchObject(unreadable);
    expect((yield* read)?.accounts[0]?.usageLimits).toMatchObject(unreadable);

    refused = false;
    const beforeRedemption = (yield* read)?.accounts[0]?.usageLimits;
    expect(beforeRedemption?.resetCredits).toBeDefined();
    const currentReading = sources.current.pipe(
      Effect.map((snapshots) => snapshots[0]?.accounts[0]?.usageLimits),
    );
    let duringRedemption: typeof beforeRedemption;
    onFailedRedemption = currentReading.pipe(
      Effect.map((reading) => {
        duringRedemption = reading;
      }),
    );
    const failed = yield* sources
      .consumeResetCredit({ sourceId, accountId: "first.json", creditId: "credit" })
      .pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    expect(duringRedemption).toMatchObject(unreadable);
    expect(duringRedemption?.resetCredits).toBeUndefined();
    expect(yield* currentReading).toMatchObject(unreadable);
    expect((yield* read)?.accounts[0]?.usageLimits).toMatchObject(unreadable);
    refused = false;
    percent = 3;
    expect((yield* read)?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(3);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({ usageLimitSources: { [sourceId]: config } }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
      NodeCrypto.layer,
      Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Path.layer,
    ]),
    Effect.scoped,
  );
});

const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

const resetFallback = (
  current: () => ReadonlyArray<UsageLimitSourceSnapshot>,
  refresh: () => Effect.Effect<void>,
) =>
  UsageLimitSources.layerResetFallback.pipe(
    Layer.provide(
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.sync(current),
        refresh: Effect.suspend(refresh),
      }),
    ),
  );

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        resetFallback(
          () => current,
          () => refresh,
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);

// GOAT's OpenCodex quota pool is listed beside the hubs; it answers first when it knows a reset.
const POOL_ORIGIN = "http://127.0.0.1:4318";
const pool = (windows: ReadonlyArray<ServerProviderUsageWindow>): UsageLimitSourceSnapshot => ({
  ...hub([{ driver: "codex", windows }]),
  id: UsageLimitSourceId.make("opencodex"),
  kind: "opencodex",
  label: "via OpenCodex Home home-1",
  origin: POOL_ORIGIN,
});
const poolOf = (
  accounts: ReadonlyArray<{
    state: NonNullable<UsageLimitSourceSnapshot["accounts"][number]["state"]>;
    windows: ReadonlyArray<ServerProviderUsageWindow>;
  }>,
): UsageLimitSourceSnapshot => {
  const source = pool([]);
  const [template] = source.accounts;
  return {
    ...source,
    accounts: template
      ? accounts.map(({ state, windows }, index) => ({
          ...template,
          id: `account-${index}`,
          state,
          usageLimits: { ...template.usageLimits, windows },
        }))
      : [],
  };
};
const roomLeft = (id: string): ServerProviderUsageWindow => ({ ...spent(id, 1), usedPercent: 40 });
const hubAt = (origin: string, windows: ReadonlyArray<ServerProviderUsageWindow>) => ({
  ...hub([{ driver: "codex", windows }]),
  origin,
});

it.effect.each([
  {
    name: "the pool's reset wins over a later one from a hub at its endpoint",
    sources: [hubAt(POOL_ORIGIN, [spent("five_hour", 4)]), pool([spent("five_hour", 2)])],
    endpoint: POOL_ORIGIN,
    expected: at(2),
  },
  {
    name: "the pool's reset wins over an earlier one from a hub at its endpoint",
    sources: [pool([spent("five_hour", 6)]), hubAt(POOL_ORIGIN, [spent("five_hour", 2)])],
    endpoint: POOL_ORIGIN,
    expected: at(6),
  },
  {
    name: "a hub answers when the pool has room",
    sources: [pool([]), hubAt(POOL_ORIGIN, [spent("five_hour", 3)])],
    endpoint: POOL_ORIGIN,
    expected: at(3),
  },
  {
    name: "nothing when neither the pool nor a hub knows a reset",
    sources: [pool([]), hubAt(POOL_ORIGIN, [])],
    endpoint: POOL_ORIGIN,
    expected: null,
  },
  {
    name: "the pool answers a loopback endpoint on its port",
    sources: [pool([spent("five_hour", 2)])],
    endpoint: "http://localhost:4318",
    expected: at(2),
  },
  {
    name: "a paused pool account with room is not counted",
    sources: [
      poolOf([
        { state: "available", windows: [spent("five_hour", 2)] },
        { state: "paused", windows: [roomLeft("five_hour")] },
      ]),
    ],
    endpoint: POOL_ORIGIN,
    expected: at(2),
  },
  {
    name: "a pool account that needs sign-in again is not counted",
    sources: [
      poolOf([
        { state: "reauth", windows: [roomLeft("five_hour")] },
        { state: "available", windows: [spent("five_hour", 2)] },
      ]),
    ],
    endpoint: POOL_ORIGIN,
    expected: at(2),
  },
  {
    name: "an exhausted pool account below 100% is spent with no known reset",
    sources: [
      poolOf([
        { state: "exhausted", windows: [roomLeft("five_hour")] },
        { state: "available", windows: [spent("five_hour", 2)] },
      ]),
    ],
    endpoint: POOL_ORIGIN,
    expected: at(2),
  },
  {
    name: "a pool whose only account is exhausted below 100% knows no reset",
    sources: [poolOf([{ state: "exhausted", windows: [roomLeft("five_hour")] }])],
    endpoint: POOL_ORIGIN,
    expected: null,
  },
  {
    name: "a hub answers its own endpoint while the pool serves another",
    sources: [pool([spent("five_hour", 2)]), hubAt("https://hub.test", [spent("five_hour", 5)])],
    endpoint: "https://hub.test",
    expected: at(5),
  },
])("reset fallback order: $name", ({ sources, endpoint, expected }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const fallback = yield* UsageLimitSources.UsageLimitResetFallback;
    expect(yield* fallback.resetAt(ProviderDriverKind.make("codex"), endpoint, null)).toBe(
      expected,
    );
  }).pipe(
    Effect.provide(
      resetFallback(
        () => sources,
        () => Effect.void,
      ),
    ),
  ),
);

// GOAT's quota verdict decides which pool windows are spent and which model they gate.
const claudePool = (
  accounts: ReadonlyArray<ReadonlyArray<ServerProviderUsageWindow>>,
): UsageLimitSourceSnapshot => {
  const source = pool([]);
  const [template] = source.accounts;
  return {
    ...source,
    accounts: template
      ? accounts.map((windows, index) => ({
          ...template,
          id: "claude-" + index,
          driver: ProviderDriverKind.make("claudeAgent"),
          state: "available" as const,
          usageLimits: { ...template.usageLimits, windows },
        }))
      : [],
  };
};
const opusWeekly: ServerProviderUsageWindow = {
  ...spent("family:opus", 72),
  scopeModel: "family:opus",
};
const markedExhausted = (hours: number): ServerProviderUsageWindow => ({
  ...spent("five_hour", hours),
  usedPercent: 98,
  exhausted: true,
});

it.effect.each([
  {
    name: "a Sonnet run on its 5-hour limit is not given the Opus weekly reset",
    sources: [claudePool([[spent("five_hour", 2), opusWeekly]])],
    model: "claude-sonnet-5-5",
    expected: at(2),
  },
  {
    name: "an Opus run waits for the Opus weekly reset",
    sources: [claudePool([[spent("five_hour", 2), opusWeekly]])],
    model: "claude-opus-5-5",
    expected: at(72),
  },
  {
    name: "a window OpenCodex marks exhausted at 98% answers with its reset",
    sources: [claudePool([[markedExhausted(1)]])],
    model: "claude-sonnet-5-5",
    expected: at(1),
  },
  {
    name: "a window marked exhausted at 98% beside another spent account gives the earlier reset",
    sources: [claudePool([[markedExhausted(1)], [spent("five_hour", 4)]])],
    model: "claude-sonnet-5-5",
    expected: at(1),
  },
])("reset fallback verdict: $name", ({ sources, model, expected }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const fallback = yield* UsageLimitSources.UsageLimitResetFallback;
    expect(
      yield* fallback.resetAt(ProviderDriverKind.make("claudeAgent"), POOL_ORIGIN, model),
    ).toBe(expected);
  }).pipe(
    Effect.provide(
      resetFallback(
        () => sources,
        () => Effect.void,
      ),
    ),
  ),
);
