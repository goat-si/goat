import type {
  ProviderHostInstallMethod,
  ProviderHostSyncDriver,
  ProviderSyncLogin,
} from "@goat/contracts";
import { withLoginShellPathNote } from "@goat/shared/cliPath";
import { CommandResolutionCache } from "@goat/shared/shell";
import * as Effect from "effect/Effect";

/**
 * The official installer and sign-in for each CLI GOAT can sync. Commands are
 * fixed argv; the only caller-supplied value is a version that already matched
 * ProviderSyncVersion, passed as its own argument so no shell parses it.
 */
export type HostPlatform = "darwin" | "linux" | "win32" | "other";

/** A vendor release GOAT downloads itself and checks against a pinned SHA-256 before unpacking. */
export interface PinnedArtifact {
  readonly version: string;
  /** `{os}` and `{arch}` are replaced by the host's `darwin`/`linux` and `x64`/`arm64`. */
  readonly url: string;
  readonly assets: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>;
  /** Under the home folder: versions live in `root/<version>`, links in `~/.local/bin`. */
  readonly root: string;
  readonly entry: string;
  readonly links: ReadonlyArray<string>;
}

export type InstallCommand =
  | {
      readonly method: "npm";
      readonly command: "npm";
      readonly args: ReadonlyArray<string>;
    }
  | {
      readonly method: "script";
      /** What unpacks the verified archive; it must be on PATH. */
      readonly command: "tar";
      readonly displayName: string;
      readonly artifact: PinnedArtifact;
    };

interface Recipe {
  readonly displayName: string;
  /** Executable a device login runs; also the first name probed on PATH. */
  readonly binary: string;
  /** Other names the same CLI installs under, probed after `binary`. */
  readonly aliases?: ReadonlyArray<string>;
  readonly npmPackage: string | null;
  readonly npmArgs?: ReadonlyArray<string>;
  /**
   * macOS and Linux release with pinned checksums, for a CLI npm does not ship. Vendor install
   * scripts are never piped into a shell: they are unpinned and unverified.
   */
  readonly posixArtifact?: PinnedArtifact;
  /** Official device login that prints a verification page and a one-time code. */
  readonly deviceLogin?: {
    readonly args: ReadonlyArray<string>;
    readonly hosts: ReadonlyArray<string>;
  };
  /** Vendor sign-in pages that finish without a callback to the target machine. */
  readonly browserHosts?: ReadonlyArray<string>;
  /** What a person runs on that machine when GOAT cannot drive sign-in. */
  readonly terminalLogin: string;
}

const RECIPES: Record<ProviderHostSyncDriver, Recipe> = {
  codex: {
    displayName: "Codex",
    binary: "codex",
    npmPackage: "@openai/codex",
    deviceLogin: { args: ["login", "--device-auth"], hosts: ["auth.openai.com"] },
    terminalLogin: "codex login --device-auth",
  },
  claudeAgent: {
    displayName: "Claude",
    binary: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    terminalLogin: "claude auth login",
  },
  cursor: {
    displayName: "Cursor",
    // Cursor's installer now links `agent`; older installs only have `cursor-agent`.
    binary: "agent",
    aliases: ["cursor-agent"],
    npmPackage: null,
    // The layout cursor.com/install creates. Windows has no pinned build, so a person installs it.
    posixArtifact: {
      version: "2026.11.11-b912975",
      url: "https://downloads.cursor.com/lab/2026.11.11-b912975/{os}/{arch}/agent-cli-package.tar.gz",
      assets: {
        "darwin-arm64": {
          sha256: "2c60b58fb7d9a54c7cb9460f0cbb10d451d4af025d4451f252e5f1d956f8c66f",
          bytes: 175_088_185,
        },
        "darwin-x64": {
          sha256: "38578cf7f2a7c67679cffaf95818b58fa3e21ff95f8883ad0af012b5d5460489",
          bytes: 182_777_324,
        },
        "linux-arm64": {
          sha256: "f068af64ed91b5304605976586f690579679f740a41f388091a6b3a2e776987c",
          bytes: 175_384_019,
        },
        "linux-x64": {
          sha256: "be01f42ad334f81d05a9992fcf060a52cc746f52cc451e849eb652146a6e3c91",
          bytes: 176_703_341,
        },
      },
      root: ".local/share/cursor-agent/versions",
      entry: "cursor-agent",
      links: ["agent", "cursor-agent"],
    },
    browserHosts: ["cursor.com"],
    terminalLogin: "agent login",
  },
  grok: {
    displayName: "Grok",
    binary: "grok",
    npmPackage: "@xai-official/grok",
    terminalLogin: "grok login",
  },
  opencode: {
    displayName: "OpenCode",
    binary: "opencode",
    npmPackage: "opencode-ai",
    terminalLogin: "opencode auth login",
  },
  omo: {
    displayName: "OmO",
    binary: "omo",
    npmPackage: "omo-ai",
    terminalLogin: "omo (then /login)",
  },
  pi: {
    displayName: "Pi",
    binary: "pi",
    npmPackage: "@earendil-works/pi-coding-agent",
    // Matches the install command pi's own status message gives.
    npmArgs: ["--ignore-scripts"],
    terminalLogin: "pi (then /login)",
  },
};

export const PROVIDER_HOST_SYNC_DRIVERS = Object.keys(
  RECIPES,
) as ReadonlyArray<ProviderHostSyncDriver>;

export const recipeFor = (driver: ProviderHostSyncDriver) => RECIPES[driver];

/** A miss cached before an install would hide the new binary for 30 seconds. */
export const forgetCommandMisses = Effect.gen(function* () {
  (yield* CommandResolutionCache).clear();
});

/** The installer exited cleanly, yet the CLI is in none of the folders this server searches. */
export const installedButNotFound = (
  binary: string,
  host: Parameters<typeof withLoginShellPathNote>[1],
) =>
  withLoginShellPathNote(
    `The installer finished, but GOAT cannot find ${binary} on its PATH here. Add the install folder to PATH and restart GOAT.`,
    host,
  );

/** Safe summary of a failed installer; the raw output never leaves this process. */
export function describeInstallFailure(exitCode: number | null, output: string): string {
  if (exitCode === null) return "The installer did not finish within 10 minutes.";
  if (/EACCES|permission denied/iu.test(output))
    return "The installer could not write its install folder for this user. Fix npm's global prefix or install it once by hand.";
  if (/ETARGET|notarget|No matching version/iu.test(output))
    return "That version is not published. Pick another version or latest.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Could not resolve host/iu.test(output))
    return "The installer could not reach the network from this machine.";
  return `The installer exited with code ${exitCode}.`;
}

/** `codex-cli 0.42.0` and `0.42.0 (Claude Code)` both pin to 0.42.0. */
export function versionCore(version: string): string | null {
  // A whole version or none: an identifier that runs on past a pin's bounds is not cut short,
  // and a build-tagged version is no pin, since a pin cannot name build metadata.
  const match =
    /(?<![0-9A-Za-z_.+-])\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z-]{1,20}(?:\.[0-9A-Za-z-]{1,20}){0,4})?(\+[0-9A-Za-z.-]*)?(?![0-9A-Za-z_+-]|\.[0-9A-Za-z])/u.exec(
      version,
    );
  return match === null || match[1] !== undefined ? null : match[0];
}

export const hostPlatform = (platform: string): HostPlatform =>
  platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";

const VERSION =
  /^(?:latest|\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z-]{1,20}(?:\.[0-9A-Za-z-]{1,20}){0,4})?)$/u;

/**
 * How GOAT installs `driver` on this platform, or null when a person must: npm at the requested
 * version, or a pinned release whose SHA-256 is checked before anything is unpacked or run.
 */
export function installCommand(
  driver: ProviderHostSyncDriver,
  platform: HostPlatform,
  version: string | null,
): InstallCommand | null {
  const requested = version ?? "latest";
  // Defense in depth: contracts already reject anything else.
  if (!VERSION.test(requested)) return null;
  const recipe = RECIPES[driver];
  if (platform === "other") return null;
  const artifact = platform === "win32" ? undefined : recipe.posixArtifact;
  if (artifact !== undefined)
    return requested === "latest" || requested === artifact.version
      ? {
          method: "script",
          command: "tar",
          displayName: recipe.displayName,
          artifact,
        }
      : null;
  if (recipe.npmPackage === null) return null;
  return {
    method: "npm",
    command: "npm",
    args: ["install", "-g", `${recipe.npmPackage}@${requested}`, ...(recipe.npmArgs ?? [])],
  };
}

/** What a person reads as what a host ran: the npm line, or the pinned release it verified. */
export function describeInstall(command: InstallCommand): string {
  if (command.method === "npm") return ["npm", ...command.args].join(" ");
  const { hostname } = new URL(command.artifact.url.replace(/\{(?:os|arch)\}/gu, "x"));
  return `${command.displayName} ${command.artifact.version} from ${hostname}, SHA-256 checked before unpacking`;
}

export function installMethod(
  driver: ProviderHostSyncDriver,
  platform: HostPlatform,
): ProviderHostInstallMethod {
  return installCommand(driver, platform, null)?.method ?? "manual";
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;

/**
 * Reads the verification page and one-time code a device login prints. Only a
 * page on the vendor's own sign-in host is relayed; anything else is ignored.
 */
export function parseDeviceLogin(
  driver: ProviderHostSyncDriver,
  output: string,
): Extract<ProviderSyncLogin, { type: "device_code" }> | null {
  const device = RECIPES[driver].deviceLogin;
  if (device === undefined) return null;
  const text = output.replace(ANSI, "");
  const code = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/u.exec(text)?.[1];
  if (code === undefined) return null;
  for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/gu)) {
    const url = safeUrl(match[0]);
    if (url !== null && device.hosts.includes(url.hostname)) {
      // The page itself is all a person needs; query and fragment could carry state.
      return { type: "device_code", url: `${url.origin}${url.pathname}`, userCode: code };
    }
  }
  return null;
}

const safeUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw.replace(/[).,;]+$/u, ""));
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
};

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/iu;
const SECRET_PARAM = /token|secret|verifier|password|session|auth_?code|^code$/iu;

/**
 * A GOAT sign-in page another machine can finish: https on that driver's
 * allowlisted vendor host, with no redirect back to the target host's
 * loopback, no pasted callback, no fragment, and no credential-like parameter.
 */
export function relayableBrowserUrl(
  driver: ProviderHostSyncDriver,
  raw: string,
  acceptsCallback: boolean | undefined,
): string | null {
  if (acceptsCallback === true) return null;
  const url = safeUrl(raw);
  const hosts = RECIPES[driver].browserHosts ?? [];
  if (url === null || url.hash !== "" || !hosts.includes(url.hostname)) return null;
  for (const [key, value] of url.searchParams) {
    if (SECRET_PARAM.test(key)) return null;
    if (!/redirect|callback|return/iu.test(key)) continue;
    const target =
      safeUrl(value) ??
      (() => {
        try {
          return new URL(value);
        } catch {
          return null;
        }
      })();
    if (target !== null && LOOPBACK.test(target.hostname)) return null;
  }
  return url.toString();
}

/**
 * A sign-in instruction another machine reported, as this machine relays it: a vendor page or
 * device code only on the vendor's own hosts, otherwise the recipe's own words for that driver.
 */
export function trustedLogin(
  driver: ProviderHostSyncDriver,
  host: string,
  login: ProviderSyncLogin,
): ProviderSyncLogin {
  const recipe = RECIPES[driver];
  const terminal = { type: "terminal", command: recipe.terminalLogin } as const;
  if (login.type === "device_code") {
    const url = safeUrl(login.url);
    const vendor = url !== null && (recipe.deviceLogin?.hosts ?? []).includes(url.hostname);
    // The page alone: a remote's query or fragment never rides along.
    return url !== null && vendor && /^[A-Z0-9]{4,5}-[A-Z0-9]{4,6}$/u.test(login.userCode)
      ? { type: "device_code", url: url.origin + url.pathname, userCode: login.userCode }
      : terminal;
  }
  if (login.type === "browser")
    return relayableBrowserUrl(driver, login.url, false) === null ? terminal : login;
  if (login.type === "open_host")
    return {
      type: "open_host",
      instruction: `Finish ${recipe.displayName} sign-in in GOAT on ${host}: Settings, Providers, ${recipe.displayName}.`,
    };
  return terminal;
}
