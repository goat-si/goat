import type {
  ProviderHostInstallMethod,
  ProviderHostSyncDriver,
  ProviderSyncLogin,
} from "@goat/contracts";

/**
 * The official installer and sign-in for each CLI GOAT can sync. Commands are
 * fixed argv; the only caller-supplied value is a version that already matched
 * ProviderSyncVersion, passed as its own argument so no shell parses it.
 */
export type HostPlatform = "darwin" | "linux" | "win32" | "other";

export interface InstallCommand {
  readonly method: Exclude<ProviderHostInstallMethod, "manual">;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Installer cannot pin a version; it always installs the latest release. */
  readonly latestOnly: boolean;
}

interface Recipe {
  readonly displayName: string;
  /** Executable a device login runs; also the first name probed on PATH. */
  readonly binary: string;
  /** Other names the same CLI installs under, probed after `binary`. */
  readonly aliases?: ReadonlyArray<string>;
  readonly npmPackage: string | null;
  readonly npmArgs?: ReadonlyArray<string>;
  /** Posix install script, run as `bash -c script goat-install <version>`. */
  readonly posixScript?: { readonly script: string; readonly pinnable: boolean };
  /** PowerShell script; `{version}` is replaced by a validated version. */
  readonly windowsScript?: { readonly script: string; readonly pinnable: boolean };
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
    posixScript: {
      script: 'curl -fsSL https://claude.ai/install.sh | bash -s -- "$1"',
      pinnable: true,
    },
    windowsScript: {
      script: "& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) {version}",
      pinnable: true,
    },
    terminalLogin: "claude auth login",
  },
  cursor: {
    displayName: "Cursor",
    // Cursor's installer now links `agent`; older installs only have `cursor-agent`.
    binary: "agent",
    aliases: ["cursor-agent"],
    npmPackage: null,
    posixScript: { script: "curl https://cursor.com/install -fsS | bash", pinnable: false },
    windowsScript: {
      script: "irm 'https://cursor.com/install?win32=true' | iex",
      pinnable: false,
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
  return (
    /\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4})?/u.exec(
      version,
    )?.[0] ?? null
  );
}

export const hostPlatform = (platform: string): HostPlatform =>
  platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";

const VERSION =
  /^(?:latest|\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4})?)$/u;

/** The command to install `driver` on this platform, or null when a person must. */
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
  const script = platform === "win32" ? recipe.windowsScript : recipe.posixScript;
  if (script !== undefined) {
    if (platform === "win32") {
      return {
        method: "script",
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script.script.replace("{version}", requested),
        ],
        latestOnly: !script.pinnable,
      };
    }
    return {
      method: "script",
      command: "bash",
      args: ["-c", script.script, "goat-install", ...(script.pinnable ? [requested] : [])],
      latestOnly: !script.pinnable,
    };
  }
  if (recipe.npmPackage === null) return null;
  return {
    method: "npm",
    command: "npm",
    args: ["install", "-g", `${recipe.npmPackage}@${requested}`, ...(recipe.npmArgs ?? [])],
    latestOnly: false,
  };
}

export function installMethod(
  driver: ProviderHostSyncDriver,
  platform: HostPlatform,
): ProviderHostInstallMethod {
  return installCommand(driver, platform, null)?.method ?? "manual";
}

// eslint-disable-next-line no-control-regex -- ANSI escapes are control characters.
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
