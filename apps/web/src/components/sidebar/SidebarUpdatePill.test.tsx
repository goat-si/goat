import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSidebarUpdateHeading } from "./SidebarUpdatePill";
import { type UpdateRunMachine } from "./updateEverything.logic";

function runMachine(updatesProviders: boolean, updatesServer: boolean): UpdateRunMachine {
  const environmentId = EnvironmentId.make("environment-1");
  return {
    environmentId,
    label: "mini",
    updatesProviders,
    server: updatesServer
      ? { environmentId, serverLabel: "mini", selfUpdate: "boot-service", targetVersion: "0.0.50" }
      : null,
    handedOffVersion: null,
    startedAt: 0,
    result: null,
    failure: null,
    providerFailure: null,
  };
}

describe("sidebar update heading", () => {
  const idle = { local: false, remote: null, run: null, checking: false } as const;

  it("names this app when only its own update is waiting", () => {
    expect(resolveSidebarUpdateHeading({ ...idle, local: true })).toBe("GOAT app update");
  });

  it("names the kinds of remote work that are behind", () => {
    expect(
      resolveSidebarUpdateHeading({ ...idle, remote: { providers: true, servers: false } }),
    ).toBe("Provider updates");
    expect(
      resolveSidebarUpdateHeading({ ...idle, remote: { providers: false, servers: true } }),
    ).toBe("Server updates");
    expect(
      resolveSidebarUpdateHeading({ ...idle, remote: { providers: true, servers: true } }),
    ).toBe("Provider and server updates");
  });

  it("says everything when this app updates along with remote work", () => {
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        local: true,
        remote: { providers: true, servers: false },
      }),
    ).toBe("Update everything");
  });

  it("names a running pass from the machines it started with", () => {
    // Providers leave the candidate list once queued, so the run decides the heading.
    const remote = { providers: false, servers: false };
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        remote,
        run: { localVersion: null, machines: [runMachine(true, false)] },
      }),
    ).toBe("Updating providers");
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        run: { localVersion: null, machines: [runMachine(false, true)] },
      }),
    ).toBe("Updating servers");
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        run: { localVersion: null, machines: [runMachine(true, false), runMachine(false, true)] },
      }),
    ).toBe("Updating providers and servers");
    expect(
      resolveSidebarUpdateHeading({
        ...idle,
        local: true,
        run: { localVersion: "0.0.52", machines: [runMachine(true, false)] },
      }),
    ).toBe("Updating everything");
  });

  it("offers an app update check when nothing is waiting, including after a failed check", () => {
    expect(resolveSidebarUpdateHeading(idle)).toBe("Check for GOAT app updates");
    expect(resolveSidebarUpdateHeading({ ...idle, checking: true })).toBe(
      "Checking for GOAT app updates…",
    );
  });
});
