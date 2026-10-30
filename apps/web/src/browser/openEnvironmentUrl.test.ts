import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentUrlUnreachableError, openEnvironmentUrlExternally } from "./openEnvironmentUrl";

const mocks = vi.hoisted(() => ({
  readPreparedConnection: vi.fn(),
  openExternal: vi.fn(async (_url: string) => undefined),
  env: { isElectron: false },
}));

vi.mock("~/state/session", () => ({ readPreparedConnection: mocks.readPreparedConnection }));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("~/env", () => mocks.env);

const environmentId = EnvironmentId.make("environment-1");
const base = { environmentId, label: "Build box" };

function setup(connection: { target: unknown; httpBaseUrl: string }, isElectron = false) {
  mocks.readPreparedConnection.mockReset().mockReturnValue(connection);
  mocks.openExternal.mockClear();
  mocks.env.isElectron = isElectron;
}

describe("openEnvironmentUrlExternally", () => {
  it("opens a remote environment's localhost server at the environment's address (regression: opened this device's localhost)", async () => {
    setup({
      target: new BearerConnectionTarget({ ...base, connectionId: "saved:box" }),
      httpBaseUrl: "http://100.65.180.100:3773",
    });
    await openEnvironmentUrlExternally(environmentId, "http://localhost:5173/app");
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith("http://100.65.180.100:5173/app");
  });

  it("refuses with the reason and opens nothing when the environment's localhost is out of reach", async () => {
    setup({
      target: new SshConnectionTarget({ ...base, connectionId: "ssh:box" }),
      httpBaseUrl: "http://127.0.0.1:41234",
    });
    const opened = openEnvironmentUrlExternally(environmentId, "http://localhost:5173/");
    await expect(opened).rejects.toBeInstanceOf(EnvironmentUrlUnreachableError);
    await expect(opened).rejects.toThrow(/localhost:5173 is on Build box/);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("opens the exact URL for the desktop's own environment", async () => {
    setup(
      {
        target: new PrimaryConnectionTarget({
          ...base,
          httpBaseUrl: "http://192.168.1.5:3773",
          wsBaseUrl: "ws://192.168.1.5:3773",
        }),
        httpBaseUrl: "http://192.168.1.5:3773",
      },
      true,
    );
    await openEnvironmentUrlExternally(environmentId, "http://0.0.0.0:5173");
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith("http://0.0.0.0:5173");
  });
});
