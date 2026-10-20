import type { CloudHolder, ProviderDiagnosis } from "@goat/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseHolder,
  cloudReadinessFromHolders,
  holderFromCloudCell,
  holderFromDiagnoses,
} from "./cloudHolders.ts";

const holder = (overrides: Partial<CloudHolder>): CloudHolder => ({
  provider: "cursorCloud",
  host: null,
  ready: true,
  runtime: "current",
  activeRuns: 0,
  ...overrides,
});

describe("chooseHolder", () => {
  it("explains how to get a login when nobody holds one", () => {
    const result = chooseHolder(
      "claudeCloud",
      [
        holder({ provider: "claudeCloud", ready: false }),
        holder({ provider: "claudeCloud", host: "box", ready: false }),
      ],
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      message:
        "No connected host holds a Claude Cloud login; run `claude auth login --claudeai` on one of: local, box.",
    });
  });

  it("uses the only ready holder", () => {
    const result = chooseHolder(
      "cursorCloud",
      [holder({ ready: false }), holder({ host: "box" })],
      undefined,
    );
    expect(result).toMatchObject({ ok: true, holder: { host: "box" } });
  });

  it("prefers the least loaded holder, then this environment, then hosts by name", () => {
    const table = [
      holder({ host: "zeta", activeRuns: 0 }),
      holder({ host: "alpha", activeRuns: 0 }),
      holder({ host: null, activeRuns: 2 }),
    ];
    expect(chooseHolder("cursorCloud", table, undefined)).toMatchObject({
      holder: { host: "alpha" },
    });
    expect(
      chooseHolder("cursorCloud", [...table, holder({ host: null, activeRuns: 0 })], undefined),
    ).toMatchObject({ holder: { host: null } });
  });

  it("never routes to a stale or unreachable runtime and says to update", () => {
    const table = [
      holder({ host: "old", runtime: "update_required" }),
      holder({ host: "gone", runtime: "unreachable", ready: false, reason: "timed out" }),
    ];
    expect(chooseHolder("cursorCloud", table, undefined)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Update GOAT on one of them"),
    });
    expect(chooseHolder("cursorCloud", table, "old")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Update GOAT on old/u),
    });
    expect(chooseHolder("cursorCloud", table, "gone")).toMatchObject({
      ok: false,
      message: "gone is unreachable: timed out",
    });
  });

  it("honours an explicit preference over load, and refuses unknown or signed-out ones", () => {
    const table = [holder({ host: null, activeRuns: 0 }), holder({ host: "busy", activeRuns: 9 })];
    expect(chooseHolder("cursorCloud", table, "busy")).toMatchObject({ holder: { host: "busy" } });
    expect(chooseHolder("cursorCloud", table, "nowhere").ok).toBe(false);
    expect(
      chooseHolder(
        "cursorCloud",
        [holder({ ready: false, reason: "Cursor Cloud is disabled." })],
        "local",
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("Cursor Cloud is disabled.") });
  });
});

const diagnosis = (overrides: Partial<ProviderDiagnosis>): ProviderDiagnosis => ({
  instanceId: ProviderInstanceId.make("claudeCloud"),
  driver: ProviderDriverKind.make("claudeCloud"),
  configured: true,
  ready: true,
  checks: [],
  ...overrides,
});

describe("cloud readiness column", () => {
  it("keeps the holder answer and drops host and runtime", () => {
    const source = holderFromDiagnoses({
      provider: "claudeCloud",
      host: "box",
      runtime: "current",
      activeRuns: 2,
      diagnoses: [
        diagnosis({
          ready: false,
          checks: [
            {
              id: "auth",
              status: "fail",
              reason: "forbidden_environment",
              summary: "ANTHROPIC_API_KEY is set.",
            },
          ],
        }),
      ],
    });
    const column = cloudReadinessFromHolders([
      source,
      holderFromDiagnoses({
        provider: "cursorCloud",
        host: "box",
        runtime: "current",
        diagnoses: [diagnosis({ driver: ProviderDriverKind.make("cursorCloud") })],
      }),
      holderFromDiagnoses({
        provider: "devinCloud",
        host: "box",
        runtime: "current",
        diagnoses: [],
      }),
    ]);
    expect(column.claudeCloud).toEqual({
      ready: false,
      instanceId: "claudeCloud",
      activeRuns: 2,
      reason: "The provider's environment overrides its sign-in (API key, proxy or Git variables).",
    });
    expect(column.cursorCloud.ready).toBe(true);
    expect(JSON.stringify(column)).not.toContain("box");
    expect(
      holderFromCloudCell({
        provider: "claudeCloud",
        host: "other",
        runtime: "update_required",
        cell: column.claudeCloud,
      }),
    ).toMatchObject({ host: "other", runtime: "update_required", ready: false });
  });
});

describe("holderFromDiagnoses", () => {
  it("reports the sign-in step from the first failing check, and no label when not ready", () => {
    const result = holderFromDiagnoses({
      provider: "claudeCloud",
      host: "box",
      runtime: "current",
      accountLabel: () => "me@example.com",
      diagnoses: [
        diagnosis({
          ready: false,
          checks: [
            { id: "enabled", status: "pass", summary: "Enabled." },
            {
              id: "auth",
              status: "fail",
              reason: "not_signed_in",
              summary: "Claude is not signed in to claude.ai.",
              fix: {
                actor: "human",
                instruction: "Sign in.",
                command: "claude auth login --claudeai",
              },
            },
          ],
        }),
      ],
    });
    expect(result).toEqual({
      provider: "claudeCloud",
      host: "box",
      runtime: "current",
      instanceId: "claudeCloud",
      ready: false,
      reason: "Not signed in.",
      command: "claude auth login --claudeai",
    });
  });

  it("never forwards a machine's own paths or values from a diagnosis", () => {
    const result = holderFromDiagnoses({
      provider: "claudeCloud",
      host: "box",
      runtime: "current",
      diagnoses: [
        diagnosis({
          ready: false,
          checks: [
            {
              id: "auth",
              status: "fail",
              reason: "not_signed_in",
              summary: "Not signed in for CLAUDE_CONFIG_DIR=/Users/me/.secret-profile.",
              fix: {
                actor: "human",
                instruction: "Sign in.",
                command:
                  'CLAUDE_CONFIG_DIR="/Users/me/.secret-profile" claude auth login --claudeai',
              },
            },
          ],
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret-profile");
    expect(result.command).toBe("claude auth login --claudeai");
  });

  it("picks a ready instance among several and names its account", () => {
    const result = holderFromDiagnoses({
      provider: "claudeCloud",
      host: null,
      runtime: "current",
      accountLabel: (id) => (id === "claudeCloud-work" ? "Work" : undefined),
      diagnoses: [
        diagnosis({ ready: false }),
        diagnosis({ instanceId: ProviderInstanceId.make("claudeCloud-work") }),
        diagnosis({ driver: ProviderDriverKind.make("devinCloud") }),
      ],
    });
    expect(result).toMatchObject({
      ready: true,
      instanceId: "claudeCloud-work",
      accountLabel: "Work",
    });
  });

  it("says when the provider has no instance", () => {
    expect(
      holderFromDiagnoses({
        provider: "devinCloud",
        host: null,
        runtime: "current",
        diagnoses: [],
      }),
    ).toMatchObject({ ready: false, reason: "No Devin Cloud instance here." });
  });
});
