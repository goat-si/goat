/**
 * `goat __open-url <url>`, run by GOAT's BROWSER shim (UrlOpenerShim.ts): a web URL opens in the
 * thread's browser preview through its own credential; anything else goes to the system opener.
 * Loaded by bin.ts before the full CLI, since the caller waits on it.
 */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";

import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";

import { callOrigin } from "../cli/agentSurfaceCli.ts";
import { threadEnvironmentFrom } from "../cli/cliCredential.ts";

export const URL_OPENER_COMMAND = "__open-url";
/** Set for the system opener this command starts, so a BROWSER that leads back here stops. */
export const URL_OPENER_FALLBACK_ENV = "GOAT_URL_OPENER_FALLBACK";

// preview.open's url bound.
const MAX_PREVIEW_URL_LENGTH = 2048;
const PREVIEW_OPEN_TIMEOUT_MS = 20_000;
const SYSTEM_OPENER_SETTLE_MS = 3_000;
const THREAD_CREDENTIAL_VARIABLE = /^(?:GOAT|T3|T3CODE|T3_CODE)_(?:ACP_MCP|MCP|CUA_LEASE)_/; // goat-rename: legacy

type Env = Readonly<Record<string, string | undefined>>;

export interface UrlOpenerIo {
  readonly env: Env;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly openInPreview: (
    url: string,
    credential: { readonly endpoint: string; readonly authorization: string },
  ) => Promise<AgentSurfaceResult>;
  readonly openWithSystem: (url: string, env: Env) => Promise<boolean>;
}

/** Plain web URLs without credentials; files, other schemes and userinfo stay with the system. */
const previewableUrl = (raw: string): boolean => {
  if (raw.length > MAX_PREVIEW_URL_LENGTH || raw.trim() !== raw) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

/** The system opener never sees the thread credential or the BROWSER that led here. */
const systemOpenerEnvironment = (env: Env): Record<string, string | undefined> => {
  const next: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === "BROWSER" || name === "ELECTRON_RUN_AS_NODE") continue;
    if (THREAD_CREDENTIAL_VARIABLE.test(name)) continue;
    next[name] = value;
  }
  next[URL_OPENER_FALLBACK_ENV] = "1";
  return next;
};

const tabIdOf = (result: AgentSurfaceResult): string | undefined => {
  if (result.status !== "ok" || typeof result.value !== "object" || result.value === null)
    return undefined;
  const { tabId, available } = result.value as { tabId?: unknown; available?: unknown };
  return available !== false && typeof tabId === "string" && tabId !== "" ? tabId : undefined;
};

export async function runUrlOpener(args: ReadonlyArray<string>, io: UrlOpenerIo): Promise<number> {
  if (io.env[URL_OPENER_FALLBACK_ENV] !== undefined) {
    io.stderr("GOAT's URL opener was started by its own system opener; not opening again.\n");
    return 1;
  }
  const url = args[0];
  if (url === undefined || args.length !== 1) {
    io.stderr(`usage: goat ${URL_OPENER_COMMAND} <url>\n`);
    return 2;
  }
  const system = async (reason: string) => {
    io.stderr(`Opening ${url} with the system browser: ${reason}\n`);
    return (await io.openWithSystem(url, systemOpenerEnvironment(io.env))) ? 0 : 1;
  };
  if (!previewableUrl(url)) return system("GOAT's browser preview opens plain http(s) URLs only.");
  const thread = threadEnvironmentFrom(io.env);
  if (thread._tag !== "present") return system("this shell has no GOAT thread.");

  const result = await io.openInPreview(url, thread);
  const tabId = tabIdOf(result);
  if (tabId !== undefined) {
    io.stdout(`Opened ${url} in GOAT's browser preview, tab ${tabId}.\n`);
    return 0;
  }
  // Exit 0 below: callers such as Python's webbrowser and xdg-open try the next browser on a
  // failure, which would open the URL anyway.
  if (result.status === "error" && result.error.code === "unauthenticated") {
    io.stderr(`GOAT did not open ${url}: this thread's GOAT session has ended or was stopped.\n`);
    return 0;
  }
  if (result.status === "error" && result.error.code === "unknown_outcome") {
    io.stderr(
      `GOAT may have opened ${url} in its browser preview; check before opening it again.\n`,
    );
    return 0;
  }
  if (result.status === "needs_human") {
    io.stderr(`GOAT is waiting for a person before it opens ${url}.\n`);
    return 0;
  }
  return system(
    result.status === "error"
      ? `GOAT's browser preview is not available (${result.error.code}: ${result.error.message}).`
      : "GOAT's browser preview did not open a tab.",
  );
}

type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Every request of the call, including the session DELETE its scope sends on close, ends at
 * `deadline`: an answer lost after dispatch is unknown_outcome, one lost before is unavailable.
 */
export const openInPreview = (
  url: string,
  credential: { readonly endpoint: string; readonly authorization: string },
  deadline: AbortSignal,
  fetchImplementation: FetchImplementation = fetch,
): Promise<AgentSurfaceResult> =>
  Effect.runPromise(
    callOrigin(
      { source: "thread", ...credential },
      {
        kind: "call",
        path: "preview.open",
        // A new tab, as a browser would open, so the agent's current tab keeps its page.
        args: { url, reuseExistingTab: false },
        json: true,
        effect: "destructive",
        format: "value",
        entryPath: "preview.open",
      },
      "destructive",
      (target, init) =>
        fetchImplementation(target, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
        }),
    ),
  );

/** Started detached; a launcher that fails within a few seconds counts as not opened. */
const openWithSystem: UrlOpenerIo["openWithSystem"] = async (url, env) => {
  const { buildBrowserLaunch } = await import("../process/externalLauncher.ts");
  const launch = buildBrowserLaunch(url, HostProcess.Platform.defaultValue(), env);
  return new Promise<boolean>((resolve) => {
    const child = NodeChildProcess.spawn(launch.command, [...launch.args], {
      detached: launch.options.detached === true,
      stdio: "ignore",
      shell: false,
      env,
    });
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, SYSTEM_OPENER_SETTLE_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
};

export const runUrlOpenerCli = (args: ReadonlyArray<string>): Promise<number> =>
  runUrlOpener(args, {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    openInPreview: (url, credential) =>
      openInPreview(url, credential, AbortSignal.timeout(PREVIEW_OPEN_TIMEOUT_MS)),
    openWithSystem,
  });
