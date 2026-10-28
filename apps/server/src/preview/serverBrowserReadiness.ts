import type { ServerBrowserReadiness } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";

const NO_DESKTOP = "It runs on this GOAT server and needs no desktop app.";
const PROVEN_BY_OPEN = "Only preview.open proves it starts.";

export interface ServerBrowserReadinessFacts {
  readonly status: PreviewBrowser.PreviewBrowserInstallStatus;
  readonly setupCommand: string;
  /** The server runs as root without `GOAT_SERVER_BROWSER_SANDBOX=0`, which Chrome refuses. */
  readonly rootSandboxed: boolean;
  /** AppArmor blocks the sandbox of GOAT's pinned browser and nobody opted out. */
  readonly sandboxBlocked: boolean;
}

export function describeServerBrowserReadiness(
  facts: ServerBrowserReadinessFacts,
): ServerBrowserReadiness {
  const { status } = facts;
  if (status._tag === "unsupported")
    return {
      state: "unsupported",
      reason: new PreviewBrowser.PreviewBrowserUnsupportedError({
        platform: status.platform,
        arch: status.arch,
      }).message,
    };
  if (status._tag === "custom" && !status.runnable)
    return {
      state: "blocked",
      reason: `GOAT_SERVER_BROWSER_EXECUTABLE_PATH names '${status.path}', which is missing or not executable. Fix or unset it on this host, then restart the GOAT server.`,
    };
  if (facts.rootSandboxed)
    return { state: "blocked", reason: new PreviewBrowserHost.PreviewBrowserRootError().message };
  if (status._tag === "custom")
    return {
      state: "installed",
      reason: `This host uses the browser at '${status.path}'. ${NO_DESKTOP} ${PROVEN_BY_OPEN}${
        facts.sandboxBlocked ? " AppArmor on this host may block its sandbox." : ""
      }`,
    };
  // The AppArmor profile GOAT writes covers only its own pinned browser.
  if (facts.sandboxBlocked)
    return {
      state: "blocked",
      reason: new PreviewBrowserHost.PreviewBrowserSandboxError({
        setupCommand: facts.setupCommand,
      }).message,
    };
  switch (status._tag) {
    case "installed":
      return {
        state: "installed",
        reason: `GOAT's headless browser is installed on this host. ${NO_DESKTOP} ${PROVEN_BY_OPEN}`,
      };
    case "notInstalled":
      return {
        state: "installs_on_open",
        reason: `GOAT's headless browser is not installed on this host yet; preview.open installs it first (about ${Math.round(status.totalBytes / 1_000_000)} MB, which can take a minute). ${NO_DESKTOP}`,
      };
    case "installing":
      return {
        state: "installing",
        reason: new PreviewBrowser.PreviewBrowserInstallingError({
          downloadedBytes: status.downloadedBytes,
          totalBytes: status.totalBytes,
          unpacking: status.unpacking,
        }).message,
      };
    case "failed":
      return {
        state: "install_failed",
        reason: `The last install of GOAT's headless browser failed: ${status.detail} preview.open starts a fresh install.`,
      };
  }
}

/** Whether this server's own browser can start for an agent, without starting or installing it. */
export const readServerBrowserReadiness = Effect.fn("ServerBrowserReadiness.read")(function* () {
  const browser = yield* PreviewBrowser.PreviewBrowser;
  const status = yield* browser.installStatus;
  const optedOut = PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment);
  const rootSandboxed = !optedOut && (yield* HostProcess.UserId) === 0;
  const sandboxBlocked = !optedOut && (yield* PreviewBrowserHost.sandboxBlocked);
  const setupCommand = sandboxBlocked
    ? yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND)
    : PreviewBrowserHost.SETUP_SUBCOMMAND;
  return describeServerBrowserReadiness({ status, setupCommand, rootSandboxed, sandboxBlocked });
});

/** The same read for promise-based callers such as the server browser's status. */
export const makeReadinessReader = Effect.gen(function* () {
  const run = Effect.runPromiseWith(
    yield* Effect.context<Effect.Services<ReturnType<typeof readServerBrowserReadiness>>>(),
  );
  return () => run(readServerBrowserReadiness());
});

/** The read for services that may run without the server browser, such as host status in tests. */
export const optionalReadiness = Effect.gen(function* () {
  const browser = yield* Effect.serviceOption(PreviewBrowser.PreviewBrowser);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(browser) || Option.isNone(fileSystem) || Option.isNone(path))
    return Option.none<Effect.Effect<ServerBrowserReadiness>>();
  return Option.some(
    readServerBrowserReadiness().pipe(
      Effect.provideService(PreviewBrowser.PreviewBrowser, browser.value),
      Effect.provideService(FileSystem.FileSystem, fileSystem.value),
      Effect.provideService(Path.Path, path.value),
    ),
  );
});
