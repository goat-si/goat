import { EnvironmentId, type ServerSelfUpdateCapability } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAppTab,
  buildRuntimesTab,
  collectServerUpdateTargets,
  describeOpenCodexUpdate,
  runWhenIdle,
  selectedRows,
  updateButtonLabel,
  type UpdateEverythingMachine,
} from "./updateEverything.logic";

const sshTarget = { alias: "mini", hostname: "mini.local", username: "dev", port: 22 };

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    savedSshTarget: null,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates saved SSH runtimes now, or with this app when it restarts", () => {
    const machines = [
      machine("ssh", "0.0.40", undefined, { savedSshTarget: sshTarget }),
      machine("manual", "0.0.40", undefined),
      machine("service", "0.0.40", "boot-service"),
    ];
    const baseline = collectServerUpdateTargets(
      machines.map((entry) => ({ ...entry, savedSshTarget: null })),
      "0.0.50",
    );
    const withApp = collectServerUpdateTargets(machines, "0.0.50", true);
    const withoutApp = collectServerUpdateTargets(machines, "0.0.50", false);
    expect(withApp.skipped.map((entry) => entry.reason)).toEqual([
      "updates with this app after it restarts",
      "needs a manual update",
    ]);
    expect(withApp.sshRuntimes).toEqual([]);
    expect(withoutApp.skipped.map((entry) => entry.reason)).toEqual(["needs a manual update"]);
    expect(withoutApp.sshRuntimes).toEqual([
      {
        environmentId: EnvironmentId.make("ssh"),
        label: "ssh",
        target: sshTarget,
        fromVersion: "0.0.40",
        targetVersion: "0.0.50",
      },
    ]);
    expect(withApp.targets).toEqual(baseline.targets);
    expect(withoutApp.targets).toEqual(baseline.targets);
  });
  it("updates remote servers that can move to the target and names every skipped one", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("never-connected", "0.0.40", "boot-service", { serverConfig: null }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("busy", "0.0.40", "boot-service", {
          updateState: {
            status: "running",
            stage: "downloading",
            fromVersion: "0.0.40",
            targetVersion: "0.0.50",
          },
        }),
        machine("current", "0.0.50", "boot-service"),
        machine("current-offline", "0.0.50", "boot-service", { connected: false }),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["nightly-service", "on the nightly channel"],
      ["offline", "not connected"],
      ["never-connected", "not connected"],
      ["no-scope", "no permission"],
      ["busy", "already updating"],
      ["manual", "needs a manual update"],
    ]);
  });
});

const id = (value: string) => EnvironmentId.make(value);

describe("buildAppTab", () => {
  const server = (name: string) => ({
    environmentId: id(name),
    serverLabel: name,
    selfUpdate: "boot-service" as const,
    targetVersion: "0.0.231-nightly.20261023.1",
    fromVersion: "0.0.228-nightly.20261020.1",
  });

  it("lists remote servers and SSH runtimes first and this Mac last", () => {
    const tab = buildAppTab({
      local: {
        environmentId: id("this-mac"),
        currentVersion: "0.0.228-nightly.20261020.1",
        version: "0.0.231-nightly.20261023.1",
        channel: "nightly",
      },
      servers: [server("mac-studio"), server("windows-mini")],
      sshRuntimes: [
        {
          environmentId: id("build"),
          label: "build",
          target: sshTarget,
          fromVersion: "0.0.228-nightly.20261020.1",
          targetVersion: "0.0.231-nightly.20261023.1",
        },
      ],
      skipped: [{ environmentId: id("offline"), label: "offline-vm", reason: "not connected" }],
      runningThreads: (environmentId) => (environmentId === "mac-studio" ? 2 : 0),
    });

    expect(tab.rows.map((row) => [row.kind, row.label])).toEqual([
      ["server", "mac-studio"],
      ["server", "windows-mini"],
      ["ssh-runtime", "build"],
      ["local", "GOAT on this Mac"],
    ]);
    expect(tab.rows.at(-1)?.detail).toBe("Nightly channel · restarts last");
    expect(tab.rows.find((row) => row.label === "mac-studio")?.runningThreads).toBe(2);
    expect(tab.skipped.map((machine) => machine.reason)).toEqual(["not connected"]);
  });

  it("names a desktop-managed server's own feed instead of a version it cannot know", () => {
    const tab = buildAppTab({
      local: null,
      servers: [{ ...server("studio-app"), selfUpdate: "desktop-managed" }],
      sshRuntimes: [],
      skipped: [],
      runningThreads: () => 0,
    });
    expect(tab.rows[0]).toMatchObject({
      detail: "Desktop app · installs its own channel",
      toVersion: null,
    });
  });
});

describe("selection", () => {
  it("counts only the checked rows that can run, and labels the button with that count", () => {
    const tab = buildRuntimesTab({
      providerMachines: [
        { environmentId: id("a"), label: "a", providers: ["Claude"] },
        { environmentId: id("b"), label: "b", providers: ["Codex", "Claude"] },
      ],
      opencodex: {
        environmentId: id("a"),
        status: {
          checkedAt: 0,
          decision: "none",
          reason: "rollout-pending",
          targetVersion: "2.91.0",
          waitingOn: [],
          advisories: [],
          members: [],
        },
        canCheck: true,
      },
    });
    expect(tab.rows.map((row) => [row.id, row.selectable])).toEqual([
      ["providers:a", true],
      ["providers:b", true],
      ["opencodex", false],
    ]);
    const selected = selectedRows(tab, new Set(["providers:a"]));
    expect(selected.map((row) => row.id)).toEqual(["providers:b"]);
    expect(updateButtonLabel(selected.length)).toBe("Update 1");
    expect(updateButtonLabel(0)).toBe("Update");
  });
});

describe("describeOpenCodexUpdate", () => {
  const status = (
    decision: "none" | "wait" | "update",
    reason: string,
    waitingOn: Array<string | null> = [],
  ) => ({
    checkedAt: 0,
    decision,
    reason,
    waitingOn,
    advisories: [],
    members: [],
  });

  it("offers a waiting update, Home first, and names the busy members", () => {
    expect(describeOpenCodexUpdate(status("wait", "busy", [null, "mac-studio"]))).toEqual({
      detail: "Home first, then Children · waits for this Mac, mac-studio",
      due: true,
    });
  });

  it("hides the row on a Child and reports states a check cannot change", () => {
    expect(describeOpenCodexUpdate(status("none", "coordinated-by-home"))).toBeNull();
    expect(describeOpenCodexUpdate(status("none", "rollout-pending"))?.due).toBe(false);
    expect(describeOpenCodexUpdate(status("update", "probation"))?.due).toBe(false);
    expect(describeOpenCodexUpdate(null)).toBeNull();
  });
});

describe("runWhenIdle", () => {
  function gate() {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("starts only after the machine is idle, and asks again after a busy refusal", async () => {
    const calls: string[] = [];
    const idle = [gate(), gate()];
    const retry = gate();
    let attempts = 0;
    const result = runWhenIdle({
      idle: () => {
        calls.push("idle?");
        return idle[calls.filter((call) => call === "idle?").length - 1]!.promise;
      },
      attempt: async () => {
        attempts += 1;
        calls.push(`attempt ${attempts}`);
        return attempts === 1 ? "busy" : "updated";
      },
      isBusy: (outcome) => outcome === "busy",
      retryLater: () => {
        calls.push("retry later");
        return retry.promise;
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(["idle?"]);
    idle[0]!.resolve(true);
    retry.resolve(true);
    idle[1]!.resolve(true);
    await expect(result).resolves.toBe("updated");
    expect(calls).toEqual(["idle?", "attempt 1", "retry later", "idle?", "attempt 2"]);
  });

  it("never attempts when a person stops waiting", async () => {
    let attempted = false;
    const result = await runWhenIdle({
      idle: async () => false,
      attempt: async () => {
        attempted = true;
        return "updated";
      },
      isBusy: () => false,
      retryLater: async () => true,
    });
    expect(result).toBeNull();
    expect(attempted).toBe(false);
  });
});
