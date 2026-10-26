import { HandoffError, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveProviderInstanceDisplayName,
  openCodexRouteSummary,
  openCodexHomeHandoff,
  codexRouteErrorMessage,
  handoffExpiryLabel,
  handoffRespondErrorMessage,
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("providerInstanceInitials", () => {
  it("treats punctuation as a word break but keeps apostrophes between letters", () => {
    expect(providerInstanceInitials("Codex (hub)")).toBe("CH");
    expect(providerInstanceInitials("work_codex")).toBe("WC");
    expect(providerInstanceInitials("Theo's Codex")).toBe("TC");
    expect(providerInstanceInitials("Codex 'hub'")).toBe("CH");
    expect(providerInstanceInitials("‘hub’")).toBe("HU");
    expect(providerInstanceInitials("(hub)")).toBe("HU");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("normalizeProviderAccentColor", () => {
  // regression: #9899 a non-hex accent must not render as the account badge color
  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });
});

describe("providerAccentForegroundColor", () => {
  it.each([
    ["#b5f23d", "#000000"],
    ["#2563eb", "#ffffff"],
    ["#777777", "#000000"],
  ])("chooses the higher WCAG contrast foreground for %s", (accent, foreground) => {
    expect(providerAccentForegroundColor(accent)).toBe(foreground);
  });
});

describe("shouldShowInstanceBadge", () => {
  it("hides badges for distinct ACP agents sharing the registry driver", () => {
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe", enabled: true };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin", enabled: true };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("distinguishes registry instances whose agent identity is unavailable", () => {
    const entry = { driverKind: acpRegistry, enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(true);
  });

  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined, enabled: true };
    const second = { driverKind: codex, accentColor: undefined, enabled: true };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("ignores disabled siblings for enabled instances while distinguishing historical owners", () => {
    const enabled = { driverKind: codex, enabled: true };
    const disabled = { driverKind: codex, enabled: false };

    expect(shouldShowInstanceBadge(enabled, [enabled, disabled])).toBe(false);
    expect(shouldShowInstanceBadge(disabled, [enabled, disabled])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled, { ...disabled }])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled])).toBe(false);
  });
});

describe("OpenCodex Home routing", () => {
  it("keeps the Home route visible beside a custom name", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_work"),
        driver: codex,
        displayName: "Work",
        codexRoute: { modelRoute: "opencodex", state: "connected" },
      }),
    ).toBe("Work · OpenCodex Home");
  });
  it("does not duplicate the Home suffix", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_home"),
        driver: codex,
        displayName: "Codex · OpenCodex Home",
        codexRoute: { modelRoute: "opencodex" },
      }),
    ).toBe("Codex · OpenCodex Home");
  });
  it.each([
    ["connected", "Home connected (home-mac)"],
    ["home", "This machine is your OpenCodex Home."],
    ["reconnecting", "Reconnecting to Home…"],
    ["failed", "Home link failed: Login required"],
    ["not_linked", "Not linked to Home."],
    ["not_running", "OpenCodex isn't running on this machine."],
  ] as const)("uses the adopted status copy: %s", (state, copy) => {
    expect(
      openCodexRouteSummary({
        modelRoute: "opencodex",
        state,
        homeLabel: "home-mac",
        reason: "Login required",
      }),
    ).toBe(copy);
  });
  it("shows the actual endpoint with Codex own settings", () => {
    expect(
      openCodexRouteSummary({
        modelRoute: "default",
        effectiveBaseUrl: "http://127.0.0.1:10100/v1",
      }),
    ).toBe("Uses Codex's own settings · http://127.0.0.1:10100/v1");
    expect(openCodexRouteSummary({ modelRoute: "default" })).toContain("Endpoint not verified");
  });
  it("does not infer connected from a missing observation", () => {
    expect(openCodexRouteSummary({ modelRoute: "opencodex" })).toBe(
      "OpenCodex Home status not checked. Check status.",
    );
    expect(openCodexRouteSummary(undefined)).toBeUndefined();
  });
  it("hands connection setup to the named execution host", () => {
    expect(
      openCodexHomeHandoff({ environmentLabel: "vps-1", action: "connect" }).instruction,
    ).toContain("On vps-1, open a terminal");
    expect(openCodexHomeHandoff({ environmentLabel: "vps-1", action: "disconnect" })).toMatchObject(
      {
        command: "ocx disconnect",
        instruction:
          "This instance goes back to Codex's own settings. OpenCodex stays connected to Home; run ocx disconnect on vps-1 to disconnect it.",
      },
    );
  });
  it("shows the recovery line for a server busy rejection", () => {
    expect(codexRouteErrorMessage({ code: "provider_instance_busy" })).toBe(
      "Wait for this instance's active turns to finish before changing its model route.",
    );
  });
});

describe("handoffRespondErrorMessage", () => {
  it("tells a person what holds the app they tried to approve, and stays generic otherwise", () => {
    const detail =
      "Thread t holds com.kakao.KakaoTalk on this host until 2026-10-25T02:11:00.000Z.";
    expect(handoffRespondErrorMessage(new HandoffError({ reason: "conflict", detail }))).toBe(
      detail,
    );
    expect(handoffRespondErrorMessage(new HandoffError({ reason: "conflict" }))).toBe(
      "Could not update this handoff. It may already be resolved or expired.",
    );
  });
});

describe("handoffExpiryLabel", () => {
  // Intl may join the time and day period with a narrow no-break space.
  const label = (iso: string, locale: string, timeZone: string) =>
    handoffExpiryLabel(DateTime.makeUnsafe(iso), { locale, timeZone }).replaceAll("\u202f", " ");

  it("shows the reader's time to the minute, in their locale", () => {
    expect(label("2026-10-25T01:12:45Z", "en-US", "Asia/Seoul")).toBe("Expires 10:12 AM");
    expect(label("2026-10-25T01:12:45Z", "en-GB", "Asia/Seoul")).toBe("Expires 10:12");
  });

  it("names the zone when clocks fall back and the same wall time comes twice", () => {
    expect(label("2026-11-01T05:30:45Z", "en-US", "America/New_York")).toBe("Expires 1:30 AM EDT");
    expect(label("2026-11-01T06:30:45Z", "en-US", "America/New_York")).toBe("Expires 1:30 AM EST");
    expect(label("2026-11-01T12:30:45Z", "en-US", "America/New_York")).toBe("Expires 7:30 AM");
  });

  it("names the zone for clock changes that are not an hour", () => {
    // Lord Howe falls back 30 minutes, Troll two hours: each wall time below comes twice.
    const lordHowe = [
      label("2026-04-04T14:45:45Z", "en-US", "Australia/Lord_Howe"),
      label("2026-04-04T15:15:45Z", "en-US", "Australia/Lord_Howe"),
    ];
    expect(lordHowe[0]).not.toBe(lordHowe[1]);
    expect(lordHowe.every((text) => text.startsWith("Expires 1:45 AM "))).toBe(true);
    const troll = [
      label("2026-10-25T00:30:45Z", "en-US", "Antarctica/Troll"),
      label("2026-10-25T02:30:45Z", "en-US", "Antarctica/Troll"),
    ];
    expect(troll[0]).not.toBe(troll[1]);
    expect(troll.every((text) => text.startsWith("Expires 2:30 AM "))).toBe(true);
  });
});
