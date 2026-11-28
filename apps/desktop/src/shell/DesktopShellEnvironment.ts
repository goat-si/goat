// Adapted from GOAT v1 apps/desktop/src/shell/DesktopShellEnvironment.ts (origin/dev 916b5ccc1b2),
// installPosixEnvironment and its cache: an app opened from Finder or the Dock gets launchd's minimal
// PATH, so the host and the agent CLIs it starts (codex, pi, opencode, muse) would not be found.
// v1's rules are kept (login shell probe -ilc with a 10 s deadline, launchctl PATH fallback on macOS,
// login shell PATH first then the inherited one, well-known CLI folders appended, preferred and
// fill-if-missing variables, locale hydration, cache keyed by platform/home/SHELL/ZDOTDIR).
// GOAT 2 differences: no Effect services; the result goes into the host's environment object (the
// host has no channel for later updates, so a refresh applies to the next host start); v1-only names
// (GOAT_RELEASE_BASE_URL, GOAT/T3 telemetry switches) and the Linux DBus/Windows probes are left out.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendWellKnownCliDirs, POSIX_LOGIN_SHELL_PROBE_TIMEOUT_MS } from "./cliPath.ts";
import { buildEnvironmentCaptureCommand, extractEnvironmentValues } from "./shellEnvironmentCapture.ts";
import { listLoginShellCandidates, mergePathValues } from "./shellPath.ts";

export const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "OTEL_SDK_DISABLED",
  "__MISE_DIFF",
  "JAVA_HOME",
  "PNPM_HOME",
] as const;
const SHELL_PREFERRED_ENV_NAMES = [
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  // Forward mise's PATH delta too, or mise x can rebuild PATH into a recursive same-named wrapper.
  "__MISE_DIFF",
] as const;
const FILL_IF_MISSING_ENV_NAMES = [
  "DISPLAY",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "WAYLAND_DISPLAY",
  // Shell CA settings are required by Node/OpenSSL builds without bundled roots for registry TLS.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "JAVA_HOME",
  "PNPM_HOME",
  "OTEL_SDK_DISABLED",
] as const;
const ANDROID_SDK_ENV_NAMES = ["ANDROID_HOME", "ANDROID_SDK_ROOT"] as const;
const LOCALE_ENV_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
const FALLBACK_LC_CTYPE = "en_US.UTF-8";
const LAUNCHCTL_TIMEOUT_MS = 2_000;
/** Every name the shell may set, cleared and re-applied on each refresh (v1 ShellEnvironmentPatch fields). */
const PATCH_ENV_NAMES: ReadonlyArray<string> = Array.from(new Set<string>([...LOGIN_SHELL_ENV_NAMES]));

type Env = NodeJS.ProcessEnv;
export type CommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env: Env; readonly timeoutMs: number },
) => Promise<string>;

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/**
 * v1 runCommandOutput / readEnvironmentFromLoginShell: stdout of a zero exit, else "". Detached, so job
 * control on an inherited controlling TTY cannot stop the probe; on the deadline the whole group gets
 * SIGKILL (interactive shells can ignore SIGTERM, and a shell's children must not outlive the probe).
 */
export const runCommandOutput: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { env: options.env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 4 * 1024 * 1024) chunks.push(chunk);
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      finish("");
    }, options.timeoutMs);
    child.once("error", () => finish(""));
    child.once("close", (code) => finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : ""));
  });

export interface ShellEnvironmentOptions {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly cacheFile: string;
  readonly log?: (line: string) => void;
  readonly run?: CommandRunner;
  readonly loginShellTimeoutMs?: number;
  /** v1 readUserLoginShell (os.userInfo().shell); injectable for tests. */
  readonly userShell?: string;
}

/**
 * v1 installPosixEnvironment: applies the login shell's environment onto env (a copy of the inherited
 * one). Returns true when the person's own first-choice shell answered with a PATH.
 */
export async function installPosixEnvironment(env: Env, options: ShellEnvironmentOptions): Promise<boolean> {
  const run = options.run ?? runCommandOutput;
  const { platform } = options;
  const shellEnvironment: Partial<Record<string, string>> = {};
  const candidates = listLoginShellCandidates(platform, env.SHELL, options.userShell);
  let answeredBy: string | undefined;
  for (const shell of candidates) {
    const output = await run(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, LOGIN_SHELL_ENV_NAMES)], {
      env,
      timeoutMs: options.loginShellTimeoutMs ?? POSIX_LOGIN_SHELL_PROBE_TIMEOUT_MS,
    });
    if (output === "") options.log?.(`shell environment: login shell ${shell} gave no answer`);
    Object.assign(shellEnvironment, extractEnvironmentValues(output, LOGIN_SHELL_ENV_NAMES));
    if (shellEnvironment.PATH) {
      answeredBy = shell;
      break;
    }
  }

  let launchctlPath: string | undefined;
  if (platform === "darwin" && !shellEnvironment.PATH) {
    const value = (await run("/bin/launchctl", ["getenv", "PATH"], { env, timeoutMs: LAUNCHCTL_TIMEOUT_MS })).replace(
      /\r?\n$/,
      "",
    );
    launchctlPath = value.length > 0 ? value : undefined;
  }
  const mergedPath = [shellEnvironment.PATH || launchctlPath, env.PATH || undefined].reduce<string | undefined>(
    (merged, value) => mergePathValues(merged, value, platform),
    undefined,
  );
  if (mergedPath !== undefined) env.PATH = mergedPath;
  if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
  for (const name of SHELL_PREFERRED_ENV_NAMES) {
    if (shellEnvironment[name]) env[name] = shellEnvironment[name];
  }
  for (const name of FILL_IF_MISSING_ENV_NAMES) {
    if (!env[name] && shellEnvironment[name]) env[name] = shellEnvironment[name];
  }
  if (ANDROID_SDK_ENV_NAMES.every((name) => trimmed(env[name]) === undefined)) {
    for (const name of ANDROID_SDK_ENV_NAMES) {
      const value = trimmed(shellEnvironment[name]);
      if (value !== undefined) env[name] = value;
    }
  }
  // Hydrate locale variables together; inherited LC_ALL can override LANG or LC_CTYPE.
  if (platform === "darwin" && LOCALE_ENV_NAMES.every((name) => trimmed(env[name]) === undefined)) {
    for (const name of LOCALE_ENV_NAMES) {
      const value = trimmed(shellEnvironment[name]);
      if (value !== undefined) env[name] = value;
    }
    // launchd lacks locale; UTF-8 LC_CTYPE fixes pbcopy's MacRoman decoding without changing C formatting or collation.
    if (LOCALE_ENV_NAMES.every((name) => trimmed(env[name]) === undefined)) env.LC_CTYPE = FALLBACK_LC_CTYPE;
  }
  // A fallback shell's PATH is used but is not the person's, so discovery stays unfinished.
  return answeredBy === candidates[0] && Boolean(shellEnvironment.PATH);
}

interface ShellEnvironmentCache {
  readonly version: 1;
  readonly key: string;
  readonly environment: Record<string, string>;
}

/**
 * The host's environment from the person's login shell (v1 DesktopShellEnvironment, adapted).
 * target is the object the host is spawned with: installCached() fills it from the last answer at
 * once; refresh() asks the login shell and rewrites the shell-owned names in place, so the next host
 * start (crash restart included) gets the fresh values; a good answer is cached for the next launch.
 */
export class DesktopShellEnvironment {
  readonly #options: ShellEnvironmentOptions;
  readonly #inherited: Env;
  readonly #key: string;

  constructor(inherited: Env, options: ShellEnvironmentOptions) {
    this.#options = options;
    this.#inherited = { ...inherited };
    this.#key = JSON.stringify([options.platform, options.homeDirectory, inherited.SHELL ?? "", inherited.ZDOTDIR ?? ""]);
  }

  /** Applies the cached answer to target; false when there is none for this platform/home/shell. */
  installCached(target: Env): boolean {
    let cache: ShellEnvironmentCache;
    try {
      cache = JSON.parse(readFileSync(this.#options.cacheFile, "utf8")) as ShellEnvironmentCache;
    } catch {
      this.#applyPatch(target, {});
      return false;
    }
    if (cache.version !== 1 || cache.key !== this.#key || typeof cache.environment !== "object") {
      this.#applyPatch(target, {});
      return false;
    }
    const environment = Object.fromEntries(
      Object.entries(cache.environment).filter(
        ([name, value]) => PATCH_ENV_NAMES.includes(name) && typeof value === "string",
      ),
    );
    this.#applyPatch(target, environment);
    return true;
  }

  /** Asks the login shell; true when the person's own shell answered with a PATH. */
  async refresh(target: Env): Promise<boolean> {
    // From the inherited baseline, so values the shell no longer sets do not survive.
    const fresh: Env = { ...this.#inherited };
    const prepared = await installPosixEnvironment(fresh, this.#options);
    const environment: Record<string, string> = {};
    for (const name of PATCH_ENV_NAMES) {
      const value = fresh[name];
      if (value !== undefined) environment[name] = value;
    }
    this.#applyPatch(target, environment);
    if (prepared) {
      try {
        mkdirSync(dirname(this.#options.cacheFile), { recursive: true });
        const temporary = `${this.#options.cacheFile}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, key: this.#key, environment }), { mode: 0o600 });
        renameSync(temporary, this.#options.cacheFile);
      } catch (error) {
        this.#options.log?.(`shell environment: could not cache: ${String(error)}`);
      }
    }
    return prepared;
  }

  /** Shell-owned names come from patch (or the inherited value); PATH also gets the well-known CLI folders. */
  #applyPatch(target: Env, patch: Record<string, string>): void {
    for (const name of PATCH_ENV_NAMES) {
      const value = patch[name] ?? this.#inherited[name];
      if (value === undefined) delete target[name];
      else target[name] = value;
    }
    const path = appendWellKnownCliDirs(target.PATH, this.#options.platform, this.#options.homeDirectory);
    if (path) target.PATH = path;
  }
}
