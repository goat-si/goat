// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem handles and special files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  devToolsUserDataDirs,
  isExternalTargetAllowed,
  parseDevToolsActivePort,
  readDevToolsActivePort,
} from "./BrowserDevToolsActivePort.ts";

const hooks = vi.hoisted(() => ({
  open: undefined as undefined | ((handle: import("node:fs/promises").FileHandle) => Promise<void>),
  beforeOpen: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      await hooks.beforeOpen?.();
      const handle = await real.open(...args);
      await hooks.open?.(handle);
      return handle;
    },
  };
});

const setup = () => {
  hooks.open = undefined;
  hooks.beforeOpen = undefined;
};
const tempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-active-port-"))),
  (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
);
const valid = "9222\n/devtools/browser/abc-123\n";
const success = {
  ok: true,
  port: 9222,
  wsPath: "/devtools/browser/abc-123",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc-123",
};

describe("browser profile directories", () => {
  it("returns each channel's platform-specific directory in order", () => {
    const channels = ["chrome", "chrome-canary", "brave", "msedge", "chromium"];
    const cases = [
      {
        platform: "darwin",
        homeDir: "/home/me",
        env: {},
        paths: [
          "/home/me/Library/Application Support/Google/Chrome",
          "/home/me/Library/Application Support/Google/Chrome Canary",
          "/home/me/Library/Application Support/BraveSoftware/Brave-Browser",
          "/home/me/Library/Application Support/Microsoft Edge",
          "/home/me/Library/Application Support/Chromium",
        ],
      },
      {
        platform: "linux",
        homeDir: "/home/me",
        env: { XDG_CONFIG_HOME: "/config" },
        paths: [
          "/config/google-chrome",
          "/config/google-chrome-unstable",
          "/config/BraveSoftware/Brave-Browser",
          "/config/microsoft-edge",
          "/config/chromium",
        ],
      },
      {
        platform: "win32",
        homeDir: "C:\\Users\\me",
        env: { LOCALAPPDATA: "D:\\Local" },
        paths: [
          "D:\\Local\\Google\\Chrome\\User Data",
          "D:\\Local\\Google\\Chrome SxS\\User Data",
          "D:\\Local\\BraveSoftware\\Brave-Browser\\User Data",
          "D:\\Local\\Microsoft\\Edge\\User Data",
          "D:\\Local\\Chromium\\User Data",
        ],
      },
    ];
    for (const { paths, ...input } of cases) {
      expect(devToolsUserDataDirs(input)).toEqual(
        channels.map((channel, i) => ({ channel, userDataDir: paths[i] })),
      );
    }
    expect(
      devToolsUserDataDirs({
        platform: "linux",
        homeDir: "/home/me",
        env: {},
        channels: ["chromium", "chrome"],
      }),
    ).toEqual([
      { channel: "chromium", userDataDir: "/home/me/.config/chromium" },
      { channel: "chrome", userDataDir: "/home/me/.config/google-chrome" },
    ]);
  });

  it("falls back from invalid environment roots and rejects invalid home roots", () => {
    for (const root of ["relative", "", "\\root", "C:relative", "\\\\host\\share", "/root"]) {
      expect(
        devToolsUserDataDirs({
          platform: "win32",
          homeDir: "C:\\home",
          env: { LOCALAPPDATA: root },
          channels: ["chrome"],
        })[0]?.userDataDir,
      ).toBe("C:\\home\\AppData\\Local\\Google\\Chrome\\User Data");
      expect(
        devToolsUserDataDirs({ platform: "win32", homeDir: root, env: { LOCALAPPDATA: root } }),
      ).toEqual([]);
    }
    expect(
      devToolsUserDataDirs({
        platform: "linux",
        homeDir: "/home/me",
        env: { XDG_CONFIG_HOME: "relative" },
        channels: ["chrome"],
      })[0]?.userDataDir,
    ).toBe("/home/me/.config/google-chrome");
    expect(
      devToolsUserDataDirs({
        platform: "linux",
        homeDir: "relative",
        env: { XDG_CONFIG_HOME: "relative" },
      }),
    ).toEqual([]);
    expect(devToolsUserDataDirs({ platform: "darwin", homeDir: "relative", env: {} })).toEqual([]);
    expect(devToolsUserDataDirs({ platform: "freebsd", homeDir: "/home/me", env: {} })).toEqual([]);
  });
});

describe("DevToolsActivePort parsing", () => {
  it("accepts LF and CRLF with or without a trailing newline and pins loopback", () => {
    for (const content of [
      valid,
      valid.trimEnd(),
      valid.replaceAll("\n", "\r\n"),
      valid.trimEnd().replaceAll("\n", "\r\n"),
    ]) {
      expect(parseDevToolsActivePort(content)).toEqual(success);
    }
  });
  it("rejects empty content and invalid port syntax", () => {
    for (const content of ["", " \t\r\n"])
      expect(parseDevToolsActivePort(content)).toEqual({ ok: false, reason: "empty_file" });
    for (const port of [
      "0",
      "65536",
      "+80",
      " 80",
      "80.0",
      "0x50",
      "080",
      "8\r0",
      "80\0",
      "80\u2028",
    ]) {
      expect(parseDevToolsActivePort(`${port}\n/devtools/browser/id`)).toEqual({
        ok: false,
        reason: "invalid_port",
      });
    }
  });
  it("rejects malformed paths and extra lines", () => {
    for (const path of [
      "",
      "/devtools/browser/..",
      "/devtools/browser/%2e",
      "/devtools/browser/id?x",
      "/devtools/browser/id#x",
      "/devtools/browser/id/extra",
      "/devtools/browser/id\\x",
      "/devtools/browser/id x",
      "/devtools/browser/id\0",
      "/devtools/browser/id\u2028",
      "/devtools/browser/id\r",
      "/devtools/browser/id\n\n",
      "/devtools/browser/id\nextra",
    ]) {
      expect(parseDevToolsActivePort(`80\n${path}`)).toEqual({
        ok: false,
        reason: "invalid_ws_path",
      });
    }
    expect(parseDevToolsActivePort("80")).toEqual({ ok: false, reason: "invalid_ws_path" });
  });
});

describe("DevToolsActivePort reader", () => {
  it.effect("reads a valid file and reports missing directory or file", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        expect(yield* readDevToolsActivePort(NodePath.join(dir, "missing"))).toEqual({
          ok: false,
          reason: "not_found",
        });
        expect(yield* readDevToolsActivePort(dir)).toEqual({ ok: false, reason: "not_found" });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, "DevToolsActivePort"), valid),
        );
        expect(yield* readDevToolsActivePort(dir)).toEqual(success);
      }),
    );
  });
  it.effect("refuses symlinked directories and files", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const profile = NodePath.join(dir, "profile");
        yield* Effect.promise(() => NodeFSP.mkdir(profile));
        const target = NodePath.join(dir, "target");
        yield* Effect.promise(() => NodeFSP.writeFile(target, valid));
        yield* Effect.promise(() =>
          NodeFSP.symlink(target, NodePath.join(profile, "DevToolsActivePort")),
        );
        expect(yield* readDevToolsActivePort(profile)).toEqual({
          ok: false,
          reason: "symlink_refused",
        });
        yield* Effect.promise(() => NodeFSP.symlink(profile, NodePath.join(dir, "link"), "dir"));
        expect(yield* readDevToolsActivePort(NodePath.join(dir, "link"))).toEqual({
          ok: false,
          reason: "symlink_refused",
        });
      }),
    );
  });
  it.effect("refuses directories and oversized files in place of the active port file", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const file = NodePath.join(dir, "DevToolsActivePort");
        yield* Effect.promise(() => NodeFSP.mkdir(file));
        expect(yield* readDevToolsActivePort(dir)).toEqual({ ok: false, reason: "not_a_file" });
        yield* Effect.promise(() => NodeFSP.rmdir(file));
        yield* Effect.promise(() => NodeFSP.writeFile(file, "x".repeat(4097)));
        expect(yield* readDevToolsActivePort(dir)).toEqual({ ok: false, reason: "too_large" });
      }),
    );
  });
  // oxlint-disable-next-line goat/no-global-process-runtime -- FIFO availability depends on the actual host.
  it.effect.skipIf(process.platform === "win32")("refuses a FIFO without blocking", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "DevToolsActivePort")]);
        expect(yield* readDevToolsActivePort(dir)).toEqual({ ok: false, reason: "not_a_file" });
      }),
    );
  });
  it.effect("rejects invalid UTF-8", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, "DevToolsActivePort"), Buffer.from([0xff])),
        );
        expect(yield* readDevToolsActivePort(dir)).toEqual({ ok: false, reason: "unreadable" });
      }),
    );
  });
  it.effect("detects a substituted profile restored after the opened file is read", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const profile = NodePath.join(dir, "profile");
        const original = NodePath.join(dir, "original");
        const substitute = NodePath.join(dir, "substitute");
        yield* Effect.promise(() => NodeFSP.mkdir(profile));
        yield* Effect.promise(() => NodeFSP.mkdir(substitute));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(profile, "DevToolsActivePort"), valid),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(substitute, "DevToolsActivePort"), valid),
        );
        hooks.beforeOpen = async () => {
          await NodeFSP.rename(profile, original);
          await NodeFSP.rename(substitute, profile);
        };
        hooks.open = async (handle) => {
          const originalRead = handle.read.bind(handle);
          let restored = false;
          handle.read = (async (...args: Parameters<typeof handle.read>) => {
            const result = await originalRead(...args);
            if (!restored) {
              restored = true;
              await NodeFSP.rename(profile, substitute);
              await NodeFSP.rename(original, profile);
            }
            return result;
          }) as typeof handle.read;
        };
        expect(yield* readDevToolsActivePort(profile)).toEqual({
          ok: false,
          reason: "changed_during_read",
        });
      }),
    );
  });
  it.effect("tolerates the browser writing other profile files during a read", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, "DevToolsActivePort"), valid),
        );
        hooks.open = async () => {
          await NodeFSP.writeFile(NodePath.join(dir, "new-entry"), "changed");
        };
        expect(yield* readDevToolsActivePort(dir)).toEqual(success);
      }),
    );
  });
  it.effect("rejects growth beyond the limit after the opened file is inspected", () => {
    setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const file = NodePath.join(dir, "DevToolsActivePort");
        yield* Effect.promise(() => NodeFSP.writeFile(file, valid));
        hooks.open = async (handle) => {
          const originalStat = handle.stat.bind(handle);
          handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
            const result = await originalStat(...args);
            await NodeFSP.appendFile(file, "x".repeat(8192));
            return result;
          }) as typeof handle.stat;
        };
        expect(yield* readDevToolsActivePort(dir)).toEqual({ ok: false, reason: "too_large" });
      }),
    );
  });
});

describe("external target eligibility", () => {
  it("allows claimed targets and nested iframes of claimed targets", () => {
    const claimedTargetIds = new Set(["root"]);
    const attachedChildren = new Map([
      ["frame", { parentTargetId: "root", type: "iframe" }],
      ["nested", { parentTargetId: "frame", type: "iframe" }],
    ]);
    for (const targetId of ["root", "frame", "nested"])
      expect(isExternalTargetAllowed({ targetId, claimedTargetIds, attachedChildren })).toEqual({
        ok: true,
      });
  });
  it("refuses unclaimed targets, non-iframe ancestors, missing parents and cycles", () => {
    const claimedTargetIds = new Set(["root", ""]);
    const attachedChildren = new Map([
      ["foreign-frame", { parentTargetId: "foreign", type: "iframe" }],
      ["worker", { parentTargetId: "root", type: "worker" }],
      ["page", { parentTargetId: "root", type: "page" }],
      ["worker-frame", { parentTargetId: "worker", type: "iframe" }],
      ["page-frame", { parentTargetId: "page", type: "iframe" }],
      ["missing", { parentTargetId: "absent", type: "iframe" }],
      ["self", { parentTargetId: "self", type: "iframe" }],
      ["a", { parentTargetId: "b", type: "iframe" }],
      ["b", { parentTargetId: "a", type: "iframe" }],
    ]);
    for (const targetId of [
      "",
      "foreign",
      "foreign-frame",
      "worker",
      "worker-frame",
      "page-frame",
      "missing",
      "self",
      "a",
    ]) {
      expect(isExternalTargetAllowed({ targetId, claimedTargetIds, attachedChildren })).toEqual({
        ok: false,
        reason: "target_not_claimed",
        targetId,
      });
    }
  });
  it("limits iframe ancestry to sixteen hops", () => {
    const attachedChildren = new Map<string, { parentTargetId: string; type: string }>();
    for (let i = 1; i <= 17; i++)
      attachedChildren.set(`frame${i}`, {
        parentTargetId: i === 1 ? "root" : `frame${i - 1}`,
        type: "iframe",
      });
    const claimedTargetIds = new Set(["root"]);
    expect(
      isExternalTargetAllowed({ targetId: "frame16", claimedTargetIds, attachedChildren }),
    ).toEqual({ ok: true });
    expect(
      isExternalTargetAllowed({ targetId: "frame17", claimedTargetIds, attachedChildren }),
    ).toEqual({ ok: false, reason: "target_not_claimed", targetId: "frame17" });
  });
});
