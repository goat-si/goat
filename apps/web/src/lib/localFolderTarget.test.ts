import { BearerConnectionTarget, PrimaryConnectionTarget } from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveLocalFolderTarget } from "./localFolderTarget";

const environmentId = EnvironmentId.make("primary");
const serverConfig = { environment: { platform: { os: "darwin" } } } as never;
const thisComputer = new PrimaryConnectionTarget({
  environmentId,
  label: "This computer",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const primary = (overrides: Record<string, unknown> = {}) =>
  ({
    environmentId,
    entry: { target: thisComputer },
    connection: { phase: "connected" },
    serverConfig,
    ...overrides,
  }) as never;
const ready = {
  isDesktopRenderer: true,
  localEnvironmentDisabled: false,
  primary: primary(),
  shellHasSnapshot: true,
};

describe("where a folder dropped from this computer opens", () => {
  it("opens in the primary environment when its server runs on this computer", () => {
    expect(resolveLocalFolderTarget(ready)).toEqual({
      kind: "ready",
      environmentId,
      platform: "darwin",
    });
  });

  it("says the local environment is off rather than waiting for it", () => {
    expect(
      resolveLocalFolderTarget({ ...ready, localEnvironmentDisabled: true, primary: null }),
    ).toEqual({ kind: "local-off" });
  });

  it("waits while this computer's server starts or loads its projects", () => {
    for (const input of [
      { ...ready, primary: null },
      { ...ready, primary: primary({ connection: { phase: "connecting" } }) },
      { ...ready, primary: primary({ serverConfig: null }) },
      { ...ready, shellHasSnapshot: false },
    ]) {
      expect(resolveLocalFolderTarget(input)).toEqual({ kind: "starting" });
    }
  });

  it("never sends this computer's folder path to a server on another machine", () => {
    const remote = new BearerConnectionTarget({
      environmentId,
      label: "Studio",
      connectionId: "paired-studio",
    });
    expect(
      resolveLocalFolderTarget({ ...ready, primary: primary({ entry: { target: remote } }) }),
    ).toEqual({ kind: "not-this-machine" });
  });

  it("needs the desktop app, since a browser does not share folder paths", () => {
    expect(resolveLocalFolderTarget({ ...ready, isDesktopRenderer: false })).toEqual({
      kind: "browser",
    });
  });
});
