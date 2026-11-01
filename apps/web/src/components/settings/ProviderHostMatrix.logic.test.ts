import {
  ProviderDriverKind,
  type ProviderHostRow,
  type ProviderHostProviderState,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  defaultSyncHosts,
  machineColumns,
  matchableLocalVersion,
  providerCell,
  safeLoginUrl,
  syncHostChoices,
  syncSummary,
} from "./ProviderHostMatrix.logic";

const provider: ProviderHostProviderState = {
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  installed: true,
  version: "1.2.3",
  auth: "signed_in",
  installMethod: "npm",
  loginMethod: "device_code",
};
const row = (
  host: string | null,
  status: ProviderHostRow["status"] = "ok",
  providers: ProviderHostRow["providers"] = [],
): ProviderHostRow => ({ host, status, providers });

describe("provider host matrix", () => {
  it("places this machine first without mutating the server result or reordering SSH hosts", () => {
    const rows = [row("b"), row(null), row("a")];
    expect(machineColumns(rows).map((entry) => entry.host)).toEqual([null, "b", "a"]);
    expect(rows[0]?.host).toBe("b");
  });
  it("shows unavailable hosts instead of presenting stale installation or auth as current", () => {
    expect(
      providerCell(
        { ...row("old", "update_runtime", [provider]), message: "Upgrade GOAT" },
        "codex",
      ),
    ).toEqual({ version: "Update runtime", auth: null, message: "Upgrade GOAT" });
    expect(providerCell(row("new", "not_ready"), "codex").version).toBe("Prepare host");
    expect(providerCell(row("offline", "unreachable"), "codex").version).toBe("Unreachable");
  });
  it("distinguishes missing, unknown version, and each authentication state", () => {
    expect(providerCell(row(null), "codex")).toMatchObject({
      version: "Not installed",
      auth: "Unknown",
    });
    expect(providerCell(row(null, "ok", [provider]), "codex")).toMatchObject({
      version: "1.2.3",
      auth: "Signed in",
    });
    expect(
      providerCell(row(null, "ok", [{ ...provider, version: null, auth: "signed_out" }]), "codex"),
    ).toMatchObject({ version: "Installed · version unknown", auth: "Signed out" });
  });
  it("preselects only reachable SSH machines missing the provider", () => {
    const rows = [
      row(null),
      row("missing"),
      row("installed", "ok", [provider]),
      row("offline", "unreachable"),
      row("old", "update_runtime"),
    ];
    expect(defaultSyncHosts(rows, "codex")).toEqual(["missing"]);
    expect(defaultSyncHosts(rows, "codex", ["installed", "offline", "nonexistent"])).toEqual([
      "installed",
    ]);
    expect(syncHostChoices(rows, "codex").find((host) => host.host === "old")).toMatchObject({
      disabled: true,
      reason: "Update runtime",
    });
  });
  it("caps default destinations to the contract's 16-host limit", () => {
    expect(
      defaultSyncHosts(
        Array.from({ length: 20 }, (_, i) => row(`host-${i}`)),
        "codex",
      ),
    ).toHaveLength(16);
  });
  it("matches only installed, reachable local versions accepted by the sync contract", () => {
    expect(matchableLocalVersion([row(null, "ok", [provider])], "codex")).toBe("1.2.3");
    for (const version of [null, "v1.2.3", "1.2.3; echo bad", "1.2"]) {
      expect(
        matchableLocalVersion([row(null, "ok", [{ ...provider, version }])], "codex"),
      ).toBeNull();
    }
    expect(
      matchableLocalVersion(
        [row(null, "unreachable", [provider]), row("other", "ok", [provider])],
        "codex",
      ),
    ).toBeNull();
  });
  it("does not call failed, cancelled, or unfinished sign-ins a success", () => {
    const hosts = ["signed_in", "installed", "failed", "cancelled", "update_runtime"].map(
      (phase) => ({
        host: null,
        version: null,
        phase: phase as "signed_in" | "installed" | "failed" | "cancelled" | "update_runtime",
      }),
    );
    expect(syncSummary({ hosts, login: true })).toBe(
      "1 of 5 machines synced · 2 need attention · 1 cancelled.",
    );
    expect(syncSummary({ hosts, login: false })).toBe(
      "2 of 5 machines synced · 2 need attention · 1 cancelled.",
    );
  });
  it("allows web verification links and rejects executable or malformed URLs", () => {
    expect(safeLoginUrl("https://example.com/device")).toBe("https://example.com/device");
    expect(safeLoginUrl("javascript:alert(1)")).toBeNull();
    expect(safeLoginUrl("file:///secret")).toBeNull();
    expect(safeLoginUrl("not a URL")).toBeNull();
  });
});
