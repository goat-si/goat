import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  openCodexRouteSummary,
  openCodexHomeHandoff,
  codexRouteErrorMessage,
  normalizeProviderAccentColor,
  providerInstanceInitials,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("resolveProviderInstanceDisplayName", () => {
  it("keeps a snapshot name that differs from the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
        displayName: "Work",
      }),
    ).toBe("Work");
  });

  it("humanizes a custom instance id when the snapshot only carries the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_personal"),
        driver: codex,
        displayName: "Codex",
      }),
    ).toBe("Codex Personal");
  });

  it("uses the brand label for the default instance", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
      }),
    ).toBe("Codex");
  });
});

describe("providerInstanceInitials", () => {
  it("takes the first two characters of a single word", () => {
    expect(providerInstanceInitials("Codex")).toBe("CO");
  });

  it("takes the first character of each of the first two words", () => {
    expect(providerInstanceInitials("Codex Personal")).toBe("CP");
  });

  it("ignores words past the first two", () => {
    expect(providerInstanceInitials("Codex Personal Backup Account")).toBe("CP");
  });

  it("returns an empty string for an empty label", () => {
    expect(providerInstanceInitials("")).toBe("");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("normalizeProviderAccentColor", () => {
  it("accepts a lowercase hex color", () => {
    expect(normalizeProviderAccentColor("#ff8800")).toBe("#ff8800");
  });

  it("accepts an uppercase hex color", () => {
    expect(normalizeProviderAccentColor("#FF8800")).toBe("#FF8800");
  });

  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });

  it("rejects a short hex value", () => {
    expect(normalizeProviderAccentColor("#fff")).toBeUndefined();
  });

  it("treats undefined and blank as unset", () => {
    expect(normalizeProviderAccentColor(undefined)).toBeUndefined();
    expect(normalizeProviderAccentColor("   ")).toBeUndefined();
  });
});

describe("shouldShowInstanceBadge", () => {
  it("hides badges for distinct ACP agents sharing the registry driver", () => {
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe" };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin" };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("shows badges for multiple instances of the same ACP agent", () => {
    const first = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe" };
    const second = { ...first };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("keeps an explicit accent on a single ACP agent", () => {
    const entry = {
      driverKind: acpRegistry,
      acpRegistryAgentId: "mistral-vibe",
      accentColor: "#ff8800",
    };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("distinguishes registry instances whose agent identity is unavailable", () => {
    const entry = { driverKind: acpRegistry };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(true);
  });

  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800" };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined };
    const second = { driverKind: codex, accentColor: undefined };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("hides the badge for a single instance of a driver with no accent", () => {
    const entry = { driverKind: codex, accentColor: undefined };
    const other = { driverKind: claude, accentColor: undefined };
    expect(shouldShowInstanceBadge(entry, [entry, other])).toBe(false);
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
