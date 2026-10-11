import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopUpdateStateSchema } from "./ipc.ts";

const decodeDesktopUpdateState = Schema.decodeUnknownSync(DesktopUpdateStateSchema);

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("DesktopUpdateStateSchema", () => {
  it("decodes update state from a desktop that predates automatic updates", () => {
    const legacy = {
      enabled: true,
      status: "idle",
      channel: "nightly",
      currentVersion: "0.0.45-nightly.20261011.3",
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      releaseNotes: [],
      downloadPercent: null,
      checkedAt: null,
      message: null,
      errorContext: null,
      canRetry: false,
      omittedReleaseCount: 0,
    };
    const state = decodeDesktopUpdateState(legacy);
    expect(state.installPolicy).toBe("restart-when-idle");
    expect(state.pendingUpdate).toBeNull();
    expect(state.recoveryStatus).toBeNull();
  });
});
