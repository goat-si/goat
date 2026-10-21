import { describe, expect, it } from "@effect/vitest";
import {
  type OpenCodexInventorySnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";

import { homeLocalFallback } from "@goat/shared/opencodexCompat";

import { decideHubWork, homeUnreachable } from "./hubDownPolicy.ts";
import type { LocalOpenCodexRoute } from "./localRoutes.ts";

const codex = ProviderDriverKind.make("codex");
const routed = ProviderInstanceId.make("codex");
const own = ProviderInstanceId.make("codex-own");
const selection = { instanceId: routed, model: "gpt-6.1-sol" };

const provider = (instanceId: ProviderInstanceId, overrides: Partial<ServerProvider> = {}) =>
  ({
    instanceId,
    driver: codex,
    displayName: "Codex (own sign-in)",
    enabled: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isCustom: false }],
    ...overrides,
  }) as ServerProvider;

const routes: ReadonlyArray<LocalOpenCodexRoute> = [
  { instanceId: routed, driver: codex, status: "ok", reason: "" },
  { instanceId: own, driver: codex, status: "failed", reason: "" },
];

const decide = (overrides: Partial<Parameters<typeof decideHubWork>[0]> = {}) =>
  decideHubWork({
    unreachable: true,
    selection,
    routes,
    providers: [provider(routed), provider(own)],
    goatAllows: true,
    openCodexAllows: true,
    ...overrides,
  });

const snapshot = (
  overrides: {
    readonly role?: "child" | "none";
    readonly hubClient?: boolean;
    readonly healthy?: boolean;
    readonly modelsStatus?: number;
    readonly fallback?: OpenCodexInventorySnapshot["fallback"];
  } = {},
): OpenCodexInventorySnapshot => ({
  installed: true,
  binaries: [],
  ownership: "adopted",
  service: { available: false },
  runtime: { port: 10100, healthy: overrides.healthy ?? true, ready: true, role: "client" },
  link: { role: overrides.role ?? "child", available: true, links: [], childSettingsApplied: true },
  ...(overrides.hubClient ? { hubClient: { state: "connected", apiKeyId: "key_1" } } : {}),
  parityEvidence: {
    observedAt: 0,
    ...(overrides.modelsStatus === undefined ? {} : { modelsStatus: overrides.modelsStatus }),
  },
  ...(overrides.fallback === undefined ? {} : { fallback: overrides.fallback }),
});

describe("decideHubWork", () => {
  it("leaves work alone while the hub answers or when the instance never used it", () => {
    expect(decide({ unreachable: false })._tag).toBe("Unaffected");
    expect(decide({ selection: { instanceId: own, model: "gpt-6.1-sol" } })._tag).toBe(
      "Unaffected",
    );
  });

  it("hops to another instance of the same provider with its own sign-in and the same model", () => {
    expect(decide()).toMatchObject({
      _tag: "Hop",
      selection: { instanceId: own, model: "gpt-6.1-sol" },
    });
  });

  it("pauses unless GOAT's switch, OpenCodex's permission and a local sign-in all allow it", () => {
    const paused = (overrides: Partial<Parameters<typeof decideHubWork>[0]>) => {
      const work = decide(overrides);
      return work._tag === "Paused" ? work.message : work._tag;
    };
    expect(paused({ goatAllows: false })).toContain("local fallback is off");
    expect(paused({ openCodexAllows: false })).toContain("OpenCodex does not allow");
    // An older OpenCodex, or a Home never read, cannot grant it.
    expect(paused({ openCodexAllows: undefined })).toContain("unknown");
    expect(
      paused({
        providers: [provider(routed), provider(own, { auth: { status: "unauthenticated" } })],
      }),
    ).toContain("own sign-in");
    expect(paused({ providers: [provider(routed), provider(own, { models: [] })] })).toContain(
      "own sign-in",
    );
    // An instance whose route is unproven may still need the hub.
    expect(
      decide({ routes: [{ instanceId: routed, driver: codex, status: "unproven", reason: "" }] })
        ._tag,
    ).toBe("Paused");
  });
});

describe("homeUnreachable", () => {
  it("is the relayed request failing on a linked device whose OpenCodex runs", () => {
    expect(homeUnreachable(snapshot({ modelsStatus: 503 }))).toBe(true);
    expect(homeUnreachable(snapshot({ role: "none", hubClient: true, modelsStatus: 502 }))).toBe(
      true,
    );
    // The Child waits for its tunnel, so the probe can time out before the 503.
    expect(homeUnreachable(snapshot())).toBe(true);
    expect(homeUnreachable(snapshot({ modelsStatus: 200 }))).toBe(false);
    expect(homeUnreachable(snapshot({ modelsStatus: 401 }))).toBe(false);
    expect(homeUnreachable(snapshot({ role: "none", modelsStatus: 503 }))).toBe(false);
    expect(homeUnreachable(snapshot({ healthy: false, modelsStatus: 503 }))).toBe(false);
  });
});

describe("homeLocalFallback", () => {
  it("trusts only the Home's own statement of this device's permission", () => {
    expect(homeLocalFallback(snapshot({ fallback: { source: "home", localFallback: true } }))).toBe(
      true,
    );
    // The Home lists every link, so no row means no permission.
    expect(homeLocalFallback(snapshot({ fallback: { source: "home" } }))).toBe(false);
    expect(
      homeLocalFallback(snapshot({ fallback: { source: "local", localFallback: true } })),
    ).toBeUndefined();
    expect(homeLocalFallback(snapshot())).toBeUndefined();
    expect(
      homeLocalFallback(
        snapshot({
          role: "none",
          hubClient: true,
          fallback: { source: "live", localFallback: true },
        }),
      ),
    ).toBe(true);
  });
});
