import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostStatusEntry, PreviewAutomationStatus } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { classifyDarwin, MAC_STANDALONE_REASON } from "../cua/CuaDisplayCapability.ts";
import {
  type InstalledDesktopApps,
  readInstalledDesktopAppsIn,
} from "../cua/installedDesktopApps.ts";
import { previewHints } from "../mcp/toolkits/preview/hints.ts";
import type { PreviewBrowserInstallStatus } from "./PreviewBrowser.ts";
import { browserArchive, makeHarness } from "./PreviewBrowser.testkit.ts";
import { describeServerBrowserReadiness } from "./serverBrowserReadiness.ts";

const readiness = (
  status: PreviewBrowserInstallStatus,
  host: { readonly rootSandboxed?: boolean; readonly sandboxBlocked?: boolean } = {},
) =>
  describeServerBrowserReadiness({
    status,
    setupCommand: "sudo goat browser setup",
    rootSandboxed: host.rootSandboxed ?? false,
    sandboxBlocked: host.sandboxBlocked ?? false,
  });

describe("server browser readiness", () => {
  it.each([
    {
      name: "a missing custom executable blocks, naming the variable",
      status: { _tag: "custom", path: "/opt/chrome", runnable: false },
      state: "blocked",
      says: "GOAT_SERVER_BROWSER_EXECUTABLE_PATH",
    },
    {
      name: "AppArmor only warns about a custom executable its profile does not cover",
      status: { _tag: "custom", path: "/opt/chrome", runnable: true },
      host: { sandboxBlocked: true },
      state: "installed",
      says: "AppArmor on this host may block its sandbox",
    },
    {
      name: "AppArmor blocks GOAT's own browser and names the setup command",
      status: { _tag: "installed" },
      host: { sandboxBlocked: true },
      state: "blocked",
      says: "sudo goat browser setup",
    },
    {
      name: "a root server without the sandbox opt-out is blocked",
      status: { _tag: "installed" },
      host: { rootSandboxed: true },
      state: "blocked",
      says: "GOAT_SERVER_BROWSER_SANDBOX=0",
    },
    {
      name: "nothing installed yet installs on open, without the desktop app",
      status: { _tag: "notInstalled", totalBytes: 90_000_000 },
      state: "installs_on_open",
      says: "needs no desktop app",
    },
    {
      name: "an install in progress is transient",
      status: { _tag: "installing", downloadedBytes: 1, totalBytes: 2, unpacking: true },
      state: "installing",
      says: "Try again in a minute",
    },
    {
      name: "a platform without a release is unsupported",
      status: { _tag: "unsupported", platform: "freebsd", arch: "x64" },
      state: "unsupported",
      says: "freebsd-x64",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    status: PreviewBrowserInstallStatus;
    host?: { readonly rootSandboxed?: boolean; readonly sandboxBlocked?: boolean };
    state: string;
    says: string;
  }>)("$name", ({ status, host, state, says }) => {
    const result = readiness(status, host);
    expect(result.state).toBe(state);
    expect(result.reason).toContain(says);
  });

  it("a status without a tab tells the agent what to do from the host's readiness", () => {
    const next = (browser?: object) =>
      previewHints("status", { tabId: null, ...(browser ? { browser } : {}) }).next;
    expect(next({ state: "blocked", reason: "x" })).toContain("do not retry");
    expect(next({ state: "installing", reason: "x" })).toContain("again in a minute");
    expect(next({ state: "install_failed", reason: "x" })).toContain("retries the install");
    // Desktop hosts and older servers send no readiness.
    expect(next()).toBe("No tab yet: call goat_preview_open with a url.");
    expect(next({ state: "a-later-state", reason: "x" })).toBe(
      "No tab yet: call goat_preview_open with a url.",
    );
  });

  it("older hosts omit browser readiness and a later or malformed value decodes away", () => {
    const status = {
      available: false,
      visible: false,
      tabId: null,
      url: null,
      title: null,
      loading: false,
    };
    const decodeStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);
    expect(decodeStatus(status).browser).toBeUndefined();
    expect(
      decodeStatus({ ...status, browser: { state: "installed", reason: "ok" } }).browser,
    ).toEqual({ state: "installed", reason: "ok" });
    expect(decodeStatus({ ...status, browser: { state: "warming", reason: "x" } }).browser).toBe(
      undefined,
    );

    const metrics = {
      sampledAt: 1,
      cpuUtilization: null,
      cpuCount: 4,
      totalMemoryBytes: 8_000,
      availableMemoryBytes: 4_000,
      loadAvg: null,
      disk: null,
      threads: { running: 0, waiting: 0, queued: 0 },
      quotas: [],
    };
    const decodeHost = Schema.decodeUnknownSync(HostStatusEntry);
    const host = (browser?: unknown) =>
      decodeHost({
        host: "mac-studio",
        reachability: "ok",
        metrics: browser === undefined ? metrics : { ...metrics, browser },
      });
    expect(host().metrics?.browser).toBeUndefined();
    expect(host({ state: "installs_on_open", reason: "r" }).metrics?.browser?.state).toBe(
      "installs_on_open",
    );
    const later = host({ state: "warming", reason: "r" });
    expect(later.reachability).toBe("ok");
    expect(later.metrics?.browser).toBeUndefined();
    expect(host("ready").metrics?.browser).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("server browser installs", (it) => {
  it.effect("a failed install stays visible until the next open retries it and succeeds", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({
        bodies: [Stream.make(browserArchive.subarray(0, -1))],
      });
      expect(readiness(yield* browser.installStatus).state).toBe("installs_on_open");

      yield* browser.executable.pipe(Effect.flip);
      const failed = readiness(yield* browser.installStatus);
      expect(failed.state).toBe("install_failed");
      expect(failed.reason).toContain("preview.open starts a fresh install");

      yield* browser.executable;
      expect(requests).toHaveLength(2);
      expect(readiness(yield* browser.installStatus).state).toBe("installed");
    }),
  );

  it.effect("reads installed GOAT apps from Info.plist and keeps unreadable ones unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const plist = (id: string, version: string) =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
      const app = Effect.fnUntraced(function* (directory: string, bundle: string, text: string) {
        const contents = path.join(directory, bundle, "Contents");
        yield* fs.makeDirectory(contents, { recursive: true });
        yield* fs.writeFileString(path.join(contents, "Info.plist"), text);
      });
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "goat-apps-none-" });
      expect(yield* readInstalledDesktopAppsIn([empty])).toEqual({ apps: [], incomplete: false });

      const apps = yield* fs.makeTempDirectoryScoped({ prefix: "goat-apps-" });
      yield* app(
        apps,
        "GOAT (Nightly).app",
        plist("si.goat.desktop.nightly", "0.1.2-nightly.20261023.246"),
      );
      yield* app(apps, "GOAT.app", "bplist00");
      expect(yield* readInstalledDesktopAppsIn([apps])).toEqual({
        apps: [{ name: "GOAT (Nightly)", version: "0.1.2-nightly.20261023.246" }],
        incomplete: true,
      });
    }),
  );
});

describe("a standalone Mac's computer use reason", () => {
  const standalone = (installedApps: InstalledDesktopApps, consoleUid = 501) =>
    classifyDarwin({ uid: 501, consoleUid, user: "jun", standalone: true, installedApps }).reason;

  it("names an installed app older than this server and the steps a person takes", () => {
    const reason = standalone({
      apps: [{ name: "GOAT (Nightly)", version: "0.0.1-nightly.20000101.1" }],
      incomplete: false,
    });
    expect(reason.startsWith(MAC_STANDALONE_REASON)).toBe(true);
    expect(reason).toContain("GOAT (Nightly) 0.0.1-nightly.20000101.1 is installed, older than");
    expect(reason).toContain("updates GOAT, opens it");
    expect(reason).toContain("Settings → Computer");
  });

  it("tells none found apart from could not check, and says who is at the screen", () => {
    expect(standalone({ apps: [], incomplete: false })).toContain(
      "No GOAT desktop app was found in Applications.",
    );
    expect(standalone({ apps: [], incomplete: false })).toContain("installs GOAT");
    const unknown = standalone({ apps: [], incomplete: true }, 0);
    expect(unknown).toContain("could not check which GOAT desktop apps are installed");
    expect(unknown).toContain("No one is signed in at this Mac's screen.");
    expect(standalone({ apps: [], incomplete: true }, 502)).toContain(
      "Another user is signed in at this Mac's screen.",
    );
  });
});
