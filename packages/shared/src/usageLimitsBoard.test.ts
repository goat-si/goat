import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { limitBoard } from "./usageLimitsBoard.ts";

const now = Date.parse("2026-10-29T12:00:00.000Z");
const at = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(now + minutes * 60_000));
const HOME = "home_3f9a1c0d2e4b5a6978f0e1d2c3b4a596";

const window = (
  id: "5h" | "weekly",
  usedPercent: number,
  resetIn: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({
  id,
  kind: id === "5h" ? "session" : "weekly",
  label: id === "5h" ? "5-hour" : "Weekly",
  usedPercent,
  resetsAt: at(resetIn),
  observedAt: at(-1),
  ...extra,
});

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: at(-1),
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const poolAccount = (
  ref: string,
  windows: ServerProviderUsageWindow[],
  extra: Partial<UsageLimitSourceAccount> = {},
): UsageLimitSourceAccount => ({
  id: JSON.stringify([HOME, "openai", `acct_${ref}`]),
  driver: ProviderDriverKind.make("codex"),
  plan: "pro",
  state: "available",
  usageLimits: { checkedAt: at(-1), windows },
  ...extra,
});

const hub = (accounts: UsageLimitSourceAccount[], error?: string) => ({
  id: UsageLimitSourceId.make("opencodex"),
  kind: "opencodex" as const,
  label: `via OpenCodex Home ${HOME}`,
  checkedAt: at(-1),
  homeId: HOME,
  accounts,
  ...(error === undefined ? {} : { error }),
});

const presentations = (providers: ServerProvider[], sources: ReturnType<typeof hub>[]) =>
  new Map([
    [
      EnvironmentId.make("laptop"),
      {
        entry: { target: { label: "Laptop" } },
        serverConfig: { providers, usageLimitSources: sources },
      },
    ],
  ]);

const localLogin = provider({
  auth: { status: "authenticated", email: "me@example.com", label: "Plus" },
  usageLimits: { checkedAt: at(-1), windows: [window("weekly", 10, 6 * 24 * 60)] },
});

describe("Usage limits board", () => {
  it("keeps hub pool accounts apart from this machine's login and never names an account by its opaque id", () => {
    const { sections } = limitBoard(
      presentations(
        [localLogin],
        [
          hub([
            poolAccount("AArxXF0kj", [window("5h", 30, 130), window("weekly", 73, 9000)], {
              label: "p61e549",
            }),
            poolAccount("Kk9zz8yy7", [window("5h", 60, 180)], { plan: undefined }),
          ]),
        ],
      ),
      now,
    );
    const groups = sections[0]?.groups ?? [];
    expect(groups.map((group) => [group.kind, group.title, group.detail])).toEqual([
      ["pool", "OpenCodex pool", "Home 3f9a1c"],
      ["login", "Signed in on Laptop", undefined],
    ]);
    const names = groups.flatMap((group) => group.rows.map((row) => row.name));
    // Most quota left first: 40% beats p61e549's tighter weekly 27%.
    expect(names).toEqual(["Account · #Kk9zz8", "Pro account · p61e549", null]);
    expect(groups[1]?.rows[0]?.email).toBe("me@example.com");
    for (const name of names) expect(name ?? "").not.toMatch(/acct_|\[|home_/);
    // Every number is quota left: the group's 5-hour column is 100 minus the mean spend.
    expect(groups[0]?.windows.map((column) => [column.label, column.remainingPercent])).toEqual([
      ["5-hour", 55],
      ["Weekly", 27],
    ]);
  });

  it("orders ready accounts by headroom, then blocked by soonest release, then no reading, paused, and signed out", () => {
    const passedReset = window("weekly", 100, -10, { exhausted: true });
    const stale = window("5h", 10, 200, { observedAt: at(-30) });
    const { sections } = limitBoard(
      presentations(
        [],
        [
          hub([
            poolAccount("ready80", [window("5h", 80, 100)], { label: "p000002" }),
            poolAccount("ready30", [window("5h", 30, 100), passedReset], { label: "p000001" }),
            poolAccount("late", [window("5h", 100, 120, { exhausted: true })], {
              label: "p000004",
            }),
            poolAccount("soon", [window("5h", 100, 60, { exhausted: true })], { label: "p000003" }),
            poolAccount("stale", [stale], { label: "p000005" }),
            poolAccount("paused", [window("weekly", 5, 900)], {
              label: "p000006",
              state: "paused",
            }),
            poolAccount("reauth", [], { label: "main", state: "reauth" }),
          ]),
        ],
      ),
      now,
    );
    const rows = sections[0]?.groups[0]?.rows ?? [];
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["Pro account · p000001", "ready"],
      ["Pro account · p000002", "ready"],
      ["Pro account · p000003", "blocked"],
      ["Pro account · p000004", "blocked"],
      ["Pro account · p000005", "unknown"],
      ["Pro account · p000006", "paused"],
      ["Pro account · main", "reauth"],
    ]);
    expect(rows[2]?.releaseAt).toBe(now + 60 * 60_000);
    expect(sections[0]?.verdict).toEqual({
      tone: "ready",
      text: "2 of 5 ready · 2 paused or signed out",
    });
  });

  it("says when the next account frees up once every active account is blocked", () => {
    const { sections } = limitBoard(
      presentations(
        [],
        [
          hub([
            poolAccount("a", [window("5h", 100, 90, { exhausted: true })], { label: "p0000aa" }),
            poolAccount("b", [window("5h", 100, 45, { exhausted: true })], { label: "p0000bb" }),
          ]),
        ],
      ),
      now,
    );
    expect(sections[0]?.verdict).toEqual({
      tone: "blocked",
      text: "All active accounts blocked · next frees in 45m",
    });
  });

  it("lists a login without a reading once, and not at all when another login reads the same account", () => {
    const failed = (instance: string, email: string) =>
      provider({
        instanceId: ProviderInstanceId.make(instance),
        auth: { status: "authenticated", email },
        usageLimits: {
          checkedAt: at(-1),
          windows: [],
          unavailable: { reason: "probeFailed", message: "Could not read limits." },
        },
      });
    const { sections } = limitBoard(
      presentations(
        [
          failed("a", "Solo@example.com"),
          failed("b", "solo@example.com"),
          failed("c", "me@example.com"),
          localLogin,
        ],
        [],
      ),
      now,
    );
    const rows = sections[0]?.groups.flatMap((group) => group.rows) ?? [];
    expect(rows.map((row) => [row.email, row.status, row.note])).toEqual([
      ["me@example.com", "ready", undefined],
      ["Solo@example.com", "unknown", "Could not read limits."],
    ]);
  });

  it("keeps an account the Home's newest snapshot cannot read, even when an older one could", () => {
    const seat = (windows: ServerProviderUsageWindow[]) =>
      poolAccount("Seat", windows, { label: "p00seat", email: "seat@example.com" });
    const older = { ...hub([seat([window("5h", 20, 100)])]), checkedAt: at(-30) };
    const newer = hub([seat([])]);
    const { sections } = limitBoard(
      new Map([
        [
          EnvironmentId.make("a"),
          {
            entry: { target: { label: "A" } },
            serverConfig: { providers: [], usageLimitSources: [older] },
          },
        ],
        [
          EnvironmentId.make("b"),
          {
            entry: { target: { label: "B" } },
            serverConfig: { providers: [], usageLimitSources: [newer] },
          },
        ],
      ]),
      now,
    );
    expect(sections[0]?.groups.flatMap((group) => group.rows).map((row) => row.status)).toEqual([
      "unknown",
    ]);
  });

  it("blocks an account OpenCodex just judged exhausted, but not one judged long ago", () => {
    const judged = (ref: string, observedAt: string) =>
      poolAccount(ref, [window("5h", 30, 100, { observedAt })], {
        label: ref,
        state: "exhausted",
        observedAt,
      });
    const { sections } = limitBoard(
      presentations([], [hub([judged("p00fres", at(-1)), judged("p00stal", at(-30))])]),
      now,
    );
    const rows = sections[0]?.groups[0]?.rows ?? [];
    expect(rows.map((row) => [row.name, row.status, row.releaseAt])).toEqual([
      ["Pro account · p00fres", "blocked", null],
      ["Pro account · p00stal", "unknown", null],
    ]);
  });

  it("blocks a no-reading account OpenCodex just judged exhausted", () => {
    const { sections } = limitBoard(
      presentations(
        [],
        [
          hub([
            poolAccount("cli", [], { plan: undefined, state: "exhausted", observedAt: at(-1) }),
          ]),
        ],
      ),
      now,
    );
    expect(sections[0]?.groups[0]?.rows.map((row) => [row.status, row.active])).toEqual([
      ["blocked", true],
    ]);
    expect(sections[0]?.verdict.text).toBe("All active accounts blocked · release time unknown");
  });

  it("lets a pool-wide block override its own members but not this machine's login", () => {
    const routed = provider({
      instanceId: ProviderInstanceId.make("routed"),
      usageLimits: {
        checkedAt: at(-1),
        windows: [],
        quotaPool: { provider: "openai", homeId: HOME, accounts: { available: 1, total: 1 } },
        quotaPoolRoute: { provider: "openai" },
        availability: [
          {
            id: "availability",
            label: "Availability",
            exhausted: true,
            resetsAt: at(50),
            observedAt: at(-1),
          },
        ],
      },
    });
    const { sections } = limitBoard(
      presentations(
        [routed, localLogin],
        [
          hub([
            poolAccount("member", [window("5h", 10, 100)], { label: "p0membr" }),
            // Its own block lifts in 10 minutes, but the pool's holds it for 50.
            poolAccount("early", [window("5h", 100, 10, { exhausted: true })], {
              label: "p0early",
            }),
          ]),
        ],
      ),
      now,
    );
    const groups = sections[0]?.groups ?? [];
    expect(
      groups.map((group) => [group.kind, group.rows.map((row) => [row.status, row.releaseAt])]),
    ).toEqual([
      [
        "pool",
        [
          ["blocked", now + 50 * 60_000],
          ["blocked", now + 50 * 60_000],
        ],
      ],
      ["login", [["ready", null]]],
    ]);
    expect(sections[0]?.verdict.text).toBe("1 of 3 ready");
  });

  it("shows an unreadable hub pool in its own group and keeps unrelated notices", () => {
    const message =
      "OpenCodex pool unavailable (OpenCodex 2.40.0): this OpenCodex has no quota-pool API.";
    const routed = provider({
      instanceId: ProviderInstanceId.make("claude_hub"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude via Hub",
      usageLimits: {
        checkedAt: at(-1),
        windows: [],
        unavailable: { reason: "probeFailed", message },
        quotaPoolRoute: { provider: "anthropic" },
      },
    });
    const { sections, notices } = limitBoard(
      presentations(
        [
          localLogin,
          routed,
          { ...routed, instanceId: ProviderInstanceId.make("claude_2"), displayName: undefined },
        ],
        [hub([], "it could not be reached")],
      ),
      now,
    );
    const claude = sections.find((section) => section.driver === "claudeAgent");
    expect(claude?.verdict).toEqual({ tone: "unknown", text: "Can't read the pool" });
    expect(claude?.groups).toMatchObject([
      {
        kind: "pool",
        unreadable: message,
        detail: "Routed: Claude via Hub on Laptop, Claude on Laptop",
        rows: [],
      },
    ]);
    expect(notices).toEqual([`via OpenCodex Home ${HOME}: it could not be reached`]);
    expect(sections.find((section) => section.driver === "codex")?.groups[0]?.title).toBe(
      "Signed in on Laptop",
    );
  });
});
