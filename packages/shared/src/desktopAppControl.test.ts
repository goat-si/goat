import { describe, expect, it } from "vite-plus/test";

import {
  resolveDesktopAppControlAddress,
  resolveDesktopAppControlAddresses,
} from "./desktopAppControl.ts";

describe("resolveDesktopAppControlAddress", () => {
  it.each([
    ["linux", "/tmp", "/tmp/goat-1000", 107],
    ["linux", "/var/tmp/custom", "/var/tmp/custom/goat-1000", 107],
    ["linux", `/tmp/${"x".repeat(120)}`, "/tmp/goat-1000", 107],
    ["darwin", `/tmp/${"é".repeat(30)}`, "/tmp/goat-1000", 103],
    ["darwin", `/tmp/${"x".repeat(56)}`, `/tmp/${"x".repeat(56)}/goat-1000`, 103],
  ] as const)("keeps %s sockets short under %s", (platform, tempDir, directory, maxBytes) => {
    const first = resolveDesktopAppControlAddress({
      stateDir: `/home/user/${"long/".repeat(40)}userdata`,
      platform,
      tempDir,
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });
    const second = resolveDesktopAppControlAddress({
      stateDir: "/home/user/.t3/other/userdata",
      platform,
      tempDir,
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });

    expect(new TextEncoder().encode(first.address).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(first.directory).toBe(directory);
    expect(first.address).not.toBe(second.address);
  });

  it("uses a Windows named pipe", () => {
    const result = resolveDesktopAppControlAddress({
      stateDir: "C:\\Users\\user\\.goat\\userdata",
      platform: "win32",
      tempDir: "C:\\Temp",
      userId: undefined,
      joinPath: (...segments) => segments.join("\\"),
    });

    expect(result.directory).toBeNull();
    expect(result.address).toMatch(/^\\\\\.\\pipe\\goat-app-[a-f0-9]{24}$/);
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "keeps the legacy %s address beside the GOAT address",
    (platform) => {
      const [primary, legacy] = resolveDesktopAppControlAddresses({
        stateDir: "/home/user/.goat/userdata",
        platform,
        tempDir: "/tmp",
        userId: 1000,
        joinPath: (...segments) => segments.join("/"),
      });
      if (platform === "win32") {
        expect(primary.directory).toBeNull();
        expect(legacy.directory).toBeNull();
        expect(legacy.address).toBe(primary.address.replace("goat-app-", "t3code-app-")); // goat-rename: legacy
      } else {
        expect(primary.directory).toBe("/tmp/goat-1000");
        expect(legacy.directory).toBe("/tmp/t3code-1000"); // goat-rename: legacy
        expect(legacy.address).toBe(primary.address.replace("goat-1000", "t3code-1000")); // goat-rename: legacy
        expect(legacy.address.length).toBeLessThan(108);
      }
    },
  );

  it("keeps the legacy hash-derived user directory when a uid is unavailable", () => {
    const [primary, legacy] = resolveDesktopAppControlAddresses({
      stateDir: "/custom/userdata",
      platform: "linux",
      tempDir: "/tmp",
      userId: undefined,
      joinPath: (...segments) => segments.join("/"),
    });
    expect(primary.directory).toMatch(/^\/tmp\/goat-[a-f0-9]{12}$/);
    expect(legacy.directory).toBe(primary.directory?.replace("goat-", "t3code-")); // goat-rename: legacy
  });
});
