import { type DesktopEnvironmentBootstrap, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopSecondaryBootstrapsReader,
  invalidateDesktopLocalBootstrapsCache,
  readDesktopLocalBootstrapsResult,
} from "./desktopLocal";

describe("desktop local topology reads", () => {
  it("reuses snapshots when polling returns fresh objects for the same topology", () => {
    const secondary: DesktopEnvironmentBootstrap = {
      id: "wsl:default",
      label: "WSL",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
      bootstrapToken: "bootstrap-1",
    };
    let entries = [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => entries.map((entry) => ({ ...entry })),
    }));

    const connected = reader.readSnapshot();
    expect(reader.readSnapshot()).toBe(connected);
    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: connected });
    expect(reader.readSnapshot()).toBe(connected);

    entries = [];
    const empty = reader.readSnapshot();
    expect(empty).toEqual([]);
    expect(reader.readSnapshot()).toBe(empty);
  });

  it.each<Partial<DesktopEnvironmentBootstrap>>([
    { id: "wsl:Debian" },
    { label: "Renamed backend" },
    { runningDistro: "Debian" },
    { httpBaseUrl: "http://127.0.0.1:4001" },
    { wsBaseUrl: "ws://127.0.0.1:4001" },
    { bootstrapToken: "bootstrap-2" },
    { accessToken: "access-2" },
  ])("publishes bootstrap changes: %j", (change) => {
    let secondary: DesktopEnvironmentBootstrap = {
      id: "wsl:default",
      label: "WSL",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
      bootstrapToken: "bootstrap-1",
    };
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [{ ...secondary }],
    }));
    const before = reader.readSnapshot();
    secondary = { ...secondary, ...change };
    const after = reader.readSnapshot();
    expect(after).not.toBe(before);
    expect(after).toEqual([secondary]);
    expect(reader.readSnapshot()).toBe(after);
  });

  it("filters the primary bootstrap from successful topology reads", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };

    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [
        {
          ...secondary,
          id: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Windows",
        },
        secondary,
      ],
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [secondary] });
  });

  it("retains the last successful snapshot only until another read succeeds", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };
    let readBootstraps = () => [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    const connectedSnapshot = reader.readSnapshot();
    expect(connectedSnapshot).toEqual([secondary]);

    readBootstraps = () => {
      throw new Error("IPC unavailable");
    };
    expect(reader.readSnapshot()).toBe(connectedSnapshot);

    readBootstraps = () => [];
    const removedSnapshot = reader.readSnapshot();
    expect(removedSnapshot).toEqual([]);

    readBootstraps = () => {
      throw new Error("IPC unavailable again");
    };
    expect(reader.readSnapshot()).toBe(removedSnapshot);
  });

  it("caches sync bootstrap reads across callers within TTL and refreshes after expiry or invalidation", () => {
    vi.useFakeTimers();
    try {
      let token = "bootstrap-1";
      const getLocalEnvironmentBootstraps = vi.fn<() => readonly DesktopEnvironmentBootstrap[]>(
        () => [
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: "Local",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: token,
          },
        ],
      );
      const bridge = { getLocalEnvironmentBootstraps };

      const first = readDesktopLocalBootstrapsResult(bridge);
      const second = readDesktopLocalBootstrapsResult(bridge);
      expect(first._tag).toBe("Success");
      expect(second).toBe(first);
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(1);

      token = "bootstrap-2";
      // Still within cache TTL: avoids redundant sync IPC.
      vi.advanceTimersByTime(5_000);
      expect(readDesktopLocalBootstrapsResult(bridge)).toBe(first);
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(1);

      // Past TTL: refreshes from bridge.
      vi.advanceTimersByTime(11_000);
      const refreshed = readDesktopLocalBootstrapsResult(bridge);
      expect(refreshed._tag).toBe("Success");
      if (refreshed._tag === "Success") {
        expect(refreshed.bootstraps[0]?.bootstrapToken).toBe("bootstrap-2");
      }
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(2);

      // Explicit invalidation forces an immediate refresh.
      token = "bootstrap-3";
      invalidateDesktopLocalBootstrapsCache();
      const invalidated = readDesktopLocalBootstrapsResult(bridge);
      expect(invalidated._tag).toBe("Success");
      if (invalidated._tag === "Success") {
        expect(invalidated.bootstraps[0]?.bootstrapToken).toBe("bootstrap-3");
      }
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
