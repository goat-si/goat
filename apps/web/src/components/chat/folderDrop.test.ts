import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { folderDropTarget, insertDroppedComposerFolders } from "./folderDrop";

const environmentId = EnvironmentId.make("saved-local");
const base = { environmentId, label: "server" };
const savedServer = (httpBaseUrl: string, connectionId = "saved-1") => ({
  target: new BearerConnectionTarget({ ...base, connectionId }),
  httpBaseUrl,
});
const thinClient = {
  localEnvironmentDisabled: true,
  environmentId,
  primaryEnvironmentId: null,
  isDesktopRenderer: true,
};

describe("folderDropTarget", () => {
  it("routes the WSL-only primary through its managed backend", () => {
    const input = {
      ...thinClient,
      localEnvironmentDisabled: false,
      primaryEnvironmentId: environmentId,
      primaryRunsInWsl: true,
      connection: null,
    };
    expect(folderDropTarget(input)).toEqual({ wslBackendId: "primary" });
  });

  it("routes a managed WSL secondary by its backend id", () => {
    expect(
      folderDropTarget({
        ...thinClient,
        localEnvironmentDisabled: false,
        connection: savedServer("http://127.0.0.1:3774", "local:wsl:Ubuntu"),
      }),
    ).toEqual({ wslBackendId: "wsl:Ubuntu" });
  });

  it.each([
    [
      "the bundled primary",
      {
        ...thinClient,
        localEnvironmentDisabled: false,
        primaryEnvironmentId: environmentId,
        connection: null,
      },
      "local",
    ],
    [
      "a saved loopback server on desktop",
      { ...thinClient, connection: savedServer("http://127.0.0.1:3773") },
      "local",
    ],
    [
      "a saved LAN server",
      { ...thinClient, connection: savedServer("http://192.168.1.20:3773") },
      "remote",
    ],
    [
      "a saved loopback server in a browser",
      { ...thinClient, isDesktopRenderer: false, connection: savedServer("http://localhost:3773") },
      "remote",
    ],
    [
      "a desktop WSL backend",
      { ...thinClient, connection: savedServer("http://127.0.0.1:3774", "local:wsl-ubuntu") },
      "remote",
    ],
    [
      "an SSH forward on loopback",
      {
        ...thinClient,
        connection: {
          target: new SshConnectionTarget({ ...base, connectionId: "ssh-1" }),
          httpBaseUrl: "http://127.0.0.1:41000",
        },
      },
      "remote",
    ],
    [
      "a relay connection",
      {
        ...thinClient,
        connection: {
          target: new RelayConnectionTarget(base),
          httpBaseUrl: "https://relay.t3.codes",
        },
      },
      "remote",
    ],
    ["an unprepared connection", { ...thinClient, connection: null }, "remote"],
  ] as const)("targets %s", (_name, input, expected) => {
    expect(folderDropTarget(input)).toBe(expected);
  });
});

describe("insertDroppedComposerFolders", () => {
  const folder = { name: "Work" } as File;

  it("rejects conversion on an older preload without inserting a Windows path", async () => {
    const insert = vi.fn(() => true);
    const onUnavailable = vi.fn();
    await insertDroppedComposerFolders({
      folders: [folder],
      target: { wslBackendId: "primary" },
      signal: new AbortController().signal,
      bridge: { getPathForFile: () => "C:\\Work" },
      onUnavailable,
      insert,
    });
    expect(onUnavailable).toHaveBeenCalledWith(folder);
    expect(insert).not.toHaveBeenCalled();
  });

  it("discards a conversion that completes after switching drafts", async () => {
    const conversion = Promise.withResolvers<string>();
    const controller = new AbortController();
    const insert = vi.fn(() => true);
    const onUnavailable = vi.fn();
    const insertion = insertDroppedComposerFolders({
      folders: [folder],
      target: { wslBackendId: "wsl:Ubuntu" },
      signal: controller.signal,
      bridge: {
        getPathForFile: () => "C:\\Work",
        toLocalBackendPath: () => conversion.promise,
      },
      onUnavailable,
      insert,
    });
    controller.abort();
    conversion.resolve("/mnt/c/Work");
    await insertion;
    expect(insert).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
