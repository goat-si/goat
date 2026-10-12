import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { EnvironmentId, ThreadId, type OrchestrationV2ThreadLauncher } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  describeThreadLauncher,
  isLaunchedFromThread,
  resolveLauncherRef,
  threadLauncherLabel,
} from "./threadLauncher.logic";

const localEnvironmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const launcherThreadId = ThreadId.make("launcher");
const launchedBy: OrchestrationV2ThreadLauncher = {
  kind: "launch",
  threadId: launcherThreadId,
  environmentId: localEnvironmentId,
  environmentLabel: null,
  threadTitle: "Launcher",
};
const launcher = scopeThreadRef(localEnvironmentId, launcherThreadId);

describe("isLaunchedFromThread", () => {
  it("rejects the same launcher thread id in a different environment", () => {
    expect(
      isLaunchedFromThread(
        {
          environmentId: localEnvironmentId,
          launchedBy: { ...launchedBy, environmentId: remoteEnvironmentId },
        },
        launcher,
      ),
    ).toBe(false);
  });

  it("resolves a null launcher environment against the shell's own environment", () => {
    const shell = {
      environmentId: remoteEnvironmentId,
      launchedBy: { ...launchedBy, environmentId: null },
    };
    expect(isLaunchedFromThread(shell, launcher)).toBe(false);
    expect(isLaunchedFromThread(shell, scopeThreadRef(remoteEnvironmentId, launcherThreadId))).toBe(
      true,
    );
  });

  it("does not count delegated children as launched top-level threads", () => {
    expect(
      isLaunchedFromThread(
        { environmentId: localEnvironmentId, launchedBy: { ...launchedBy, via: "delegate_task" } },
        launcher,
      ),
    ).toBe(false);
  });

  it("does not count promotions as launches", () => {
    expect(
      isLaunchedFromThread(
        { environmentId: localEnvironmentId, launchedBy: { ...launchedBy, kind: "promotion" } },
        launcher,
      ),
    ).toBe(false);
  });

  it("ignores threads without a launcher or with a different launcher thread", () => {
    expect(isLaunchedFromThread({ environmentId: localEnvironmentId }, launcher)).toBe(false);
    expect(
      isLaunchedFromThread(
        {
          environmentId: localEnvironmentId,
          launchedBy: { ...launchedBy, threadId: ThreadId.make("other-launcher") },
        },
        launcher,
      ),
    ).toBe(false);
  });

  it("matches an explicit launcher environment even when the launched thread is remote", () => {
    expect(isLaunchedFromThread({ environmentId: remoteEnvironmentId, launchedBy }, launcher)).toBe(
      true,
    );
  });
});

describe("resolveLauncherRef", () => {
  it("uses the explicit launcher environment", () => {
    expect(resolveLauncherRef(launchedBy, remoteEnvironmentId)).toEqual({
      environmentId: localEnvironmentId,
      threadId: launcherThreadId,
    });
  });

  it("uses the launched thread's own environment when the launcher environment is null", () => {
    expect(resolveLauncherRef({ ...launchedBy, environmentId: null }, remoteEnvironmentId)).toEqual(
      {
        environmentId: remoteEnvironmentId,
        threadId: launcherThreadId,
      },
    );
  });
});

it("keeps launched threads with the same id in different environments distinct", () => {
  const threadId = ThreadId.make("launched");
  const rows = [localEnvironmentId, remoteEnvironmentId].map((environmentId) => ({
    environmentId,
    launchedBy,
    ref: scopeThreadRef(environmentId, threadId),
  }));
  const launchedRows = rows.filter((shell) => isLaunchedFromThread(shell, launcher));
  expect(launchedRows.map(({ ref }) => ref)).toEqual([
    { environmentId: localEnvironmentId, threadId },
    { environmentId: remoteEnvironmentId, threadId },
  ]);
  expect(new Set(launchedRows.map(({ ref }) => scopedThreadKey(ref))).size).toBe(2);
});

it("labels launches and promotions", () => {
  expect(threadLauncherLabel("launch")).toBe("Launched by");
  expect(threadLauncherLabel("promotion")).toBe("Promoted from");
});

describe("describeThreadLauncher", () => {
  it("names the launching machine for a launch from another machine", () => {
    expect(
      describeThreadLauncher({
        kind: "launch",
        title: "Fix CI",
        machine: "build-box",
        available: true,
      }),
    ).toBe("Launched by “Fix CI” on build-box");
  });

  it("says how to reach a launcher this app has not loaded", () => {
    expect(
      describeThreadLauncher({
        kind: "launch",
        title: "Fix CI",
        machine: "build-box",
        available: false,
      }),
    ).toBe("Launched by “Fix CI” on build-box. Connect build-box to open it.");
    expect(
      describeThreadLauncher({ kind: "promotion", title: "Plan", machine: null, available: false }),
    ).toBe("Promoted from “Plan”. It is not available in this app.");
  });
});
