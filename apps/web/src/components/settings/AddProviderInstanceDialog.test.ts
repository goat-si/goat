import { describe, expect, it } from "vite-plus/test";

import {
  deriveAvailableInstanceId,
  getProviderIdentityDraft,
  resolveAcpRegistryWizardNavigation,
  resolveProviderSetupPlan,
  resolveWizardNavigation,
  summarizeDriverSetupState,
  updateProviderIdentityDraft,
} from "./AddProviderInstanceDialog.logic";

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };

  // regression: #2813 the wizard advanced past an invalid instance id
  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });
});

describe("ACP Registry wizard", () => {
  it("requires a prepared result or valid manual configuration before Identity", () => {
    expect(
      resolveAcpRegistryWizardNavigation(0, 1, {
        instanceIdError: null,
        selectionError: "Select an ACP or configure one manually.",
      }),
    ).toEqual({
      kind: "blocked",
      step: 0,
      error: "Select an ACP or configure one manually.",
    });

    expect(
      resolveAcpRegistryWizardNavigation(0, 1, {
        instanceIdError: null,
        selectionError: null,
      }),
    ).toEqual({ kind: "navigate", step: 1 });
  });

  it("derives a collision-free instance id without exceeding the slug limit", () => {
    const derive = (label: string) => `acpRegistry_${label}`;
    const existing = new Set(["acpRegistry_gemini", "acpRegistry_gemini_2"]);

    expect(deriveAvailableInstanceId(derive, "gemini", existing)).toBe("acpRegistry_gemini_3");

    const longBase = `acpRegistry_${"a".repeat(48)}`;
    expect(deriveAvailableInstanceId(() => longBase, "ignored", new Set([longBase]))).toHaveLength(
      62,
    );
  });

  it("keeps registry-prefilled identity separate from other drivers", () => {
    const registryDrafts = updateProviderIdentityDraft({}, "acpRegistry", {
      label: "Gemini CLI",
      instanceIdOverride: "acpRegistry_gemini_cli",
    });

    expect(getProviderIdentityDraft(registryDrafts, "codex")).toEqual({
      label: "",
      accentColor: "",
      instanceIdOverride: null,
    });

    const drafts = updateProviderIdentityDraft(registryDrafts, "codex", {
      label: "Work",
      instanceIdOverride: "codex_work",
    });
    expect(getProviderIdentityDraft(drafts, "acpRegistry")).toMatchObject({
      label: "Gemini CLI",
      instanceIdOverride: "acpRegistry_gemini_cli",
    });
  });
});

describe("summarizeDriverSetupState", () => {
  const snapshot = (
    driver: string,
    installed: boolean,
    auth: "authenticated" | "unauthenticated" | "unknown",
    status: "ready" | "disabled" | "error" = "ready",
  ) => ({ driver, installed, status, auth: { status: auth } }) as never;

  it("is unknown until the environment has checked a snapshot of the driver", () => {
    expect(summarizeDriverSetupState([snapshot("codex", true, "authenticated")], "grok")).toBe(
      null,
    );
    expect(
      summarizeDriverSetupState([snapshot("grok", false, "unknown", "disabled")], "grok"),
    ).toBe(null);
  });

  it("reports the most advanced state across the driver's instances", () => {
    expect(
      summarizeDriverSetupState(
        [
          snapshot("claudeAgent", true, "unauthenticated"),
          snapshot("claudeAgent", true, "authenticated"),
        ],
        "claudeAgent",
      ),
    ).toBe("signedIn");
    expect(summarizeDriverSetupState([snapshot("opencode", true, "unknown")], "opencode")).toBe(
      "installed",
    );
    expect(
      summarizeDriverSetupState([snapshot("cursor", false, "unknown", "error")], "cursor"),
    ).toBe("missing");
  });
});

describe("resolveProviderSetupPlan", () => {
  const provider = (patch: Record<string, unknown>) =>
    ({
      driver: "claudeAgent",
      installed: true,
      auth: { status: "unauthenticated" },
      setup: { canAuthenticate: true, canInstall: false },
      ...patch,
    }) as never;
  const plan = (
    snapshot: ReturnType<typeof provider> | undefined,
    auth: Record<string, unknown> | null = null,
  ) => resolveProviderSetupPlan({ provider: snapshot, auth: auth as never, authError: null });

  it("waits for the new instance's first snapshot", () => {
    expect(plan(undefined)).toEqual({ kind: "checking" });
  });

  it("installs before sign-in, in the app only when the environment can", () => {
    expect(plan(provider({ installed: false }))).toEqual({ kind: "install", inApp: false });
    expect(
      plan(provider({ installed: false, setup: { canAuthenticate: true, canInstall: true } })),
    ).toEqual({ kind: "install", inApp: true });
  });

  it("signs in inside the app when the driver advertises it", () => {
    expect(plan(provider({}))).toEqual({ kind: "signIn" });
    expect(plan(provider({ auth: { status: "authenticated" } }))).toEqual({ kind: "signedIn" });
    expect(plan(provider({ auth: { status: "unknown" } }), { phase: "succeeded" })).toEqual({
      kind: "signedIn",
    });
  });

  it("falls back to the provider's own command, or its docs, without an in-app method", () => {
    const noInApp = { canAuthenticate: false, canInstall: false };
    expect(plan(provider({ setup: noInApp }))).toEqual({
      kind: "command",
      command: "claude auth login",
    });
    expect(plan(provider({ driver: "opencode", setup: noInApp }))).toEqual({
      kind: "command",
      command: "opencode auth login",
    });
    expect(plan(provider({ driver: "grok", setup: noInApp }))).toEqual({ kind: "manual" });
  });

  it("waits for an ACP agent to advertise its methods before choosing", () => {
    const acp = provider({ driver: "acpRegistry" });
    expect(plan(acp, { phase: "idle" })).toEqual({ kind: "discovering" });
    expect(plan(acp, { phase: "idle", methods: [{ id: "oauth" }] })).toEqual({ kind: "signIn" });
    expect(plan(acp, { phase: "idle", methods: [] })).toEqual({ kind: "manual" });
  });
});
