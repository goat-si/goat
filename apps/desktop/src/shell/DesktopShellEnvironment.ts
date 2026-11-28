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
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendWellKnownCliDirs, LOGIN_SHELL_RETRY_DELAYS_MS, POSIX_LOGIN_SHELL_PROBE_TIMEOUT_MS } from "./cliPath.ts";
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
  options: { readonly env: Env; readonly timeoutMs: number; readonly probes?: LiveShellProbes },
) => Promise<string>;

/**
 * v1 loginShellRetry LiveShellProbes, adapted: a probe process counts from its spawn until its exit
 * is observed (a killed shell stuck in the kernel never exits), so a retry starts only when every
 * earlier probe is known to be gone.
 */
export class LiveShellProbes {
  readonly #running = new Set<object>();
  track(child: { once(event: "exit", listener: () => void): unknown }): void {
    const token = {};
    this.#running.add(token);
    child.once("exit", () => this.#running.delete(token));
  }
  get allGone(): boolean {
    return this.#running.size === 0;
  }
}

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
    if (child.pid !== undefined) options.probes?.track(child);
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
  /** Counts this environment's probe processes (set by DesktopShellEnvironment). */
  readonly probes?: LiveShellProbes;
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
    // A timed-out probe that has not exited (stuck after SIGKILL) must not overlap another login
    // shell; launchctl below only reads launchd state and still runs.
    if (options.probes !== undefined && !options.probes.allGone) {
      options.log?.(`shell environment: an earlier login shell has not exited; not trying ${shell}`);
      break;
    }
    const output = await run(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, LOGIN_SHELL_ENV_NAMES)], {
      env,
      timeoutMs: options.loginShellTimeoutMs ?? POSIX_LOGIN_SHELL_PROBE_TIMEOUT_MS,
      ...(options.probes ? { probes: options.probes } : {}),
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
    const value = (await run("/bin/launchctl", ["getenv", "PATH"], {
      env,
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
      ...(options.probes ? { probes: options.probes } : {}),
    })).replace(
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

/** v1 CACHED_ENV_NAMES: only these survive to the next launch; session values (SSH_AUTH_SOCK, locale,
 * display/XDG sockets) are never cached, they belong to the session that is running. */
const CACHED_ENV_NAMES = [
  "PATH",
  "__MISE_DIFF",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "JAVA_HOME",
  "PNPM_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;
const MAX_CACHE_BYTES = 1024 * 1024;

/** v1 ShellEnvironmentCache decode: version 1, string key, an object of string values; anything else is a miss. */
function decodeCache(text: string): { key: string; environment: Record<string, string> } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { version, key, environment } = value as Record<string, unknown>;
  if (version !== 1 || typeof key !== "string") return undefined;
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) return undefined;
  const entries = Object.entries(environment as Record<string, unknown>);
  if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
  return { key, environment: Object.fromEntries(entries) as Record<string, string> };
}

/**
 * v1 loginShellRetry discoverWithRetries: one discovery, then a fixed number of further ones with
 * growing gaps until one succeeds. A further one starts only when every earlier probe process is
 * known to have exited; otherwise the retries end there. POSIX only.
 */
export async function discoverWithRetries(
  discover: () => Promise<boolean>,
  platform: NodeJS.Platform,
  earlierProbesGone: () => boolean,
  options: {
    readonly delays?: ReadonlyArray<number>;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly log?: (line: string) => void;
  } = {},
): Promise<boolean> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  if (await discover()) return true;
  if (platform !== "darwin" && platform !== "linux") return false;
  for (const delay of options.delays ?? LOGIN_SHELL_RETRY_DELAYS_MS) {
    await sleep(delay);
    if (!earlierProbesGone()) {
      options.log?.("shell environment: a login shell probe is not known to have exited; no further probes");
      return false;
    }
    if (await discover()) return true;
  }
  options.log?.("shell environment: the login shell never answered with a PATH; no further probes");
  return false;
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
  /** v1 `latest`: a snapshot (cached or answered) is in target; a failed refresh must not replace it. */
  #hasSnapshot = false;

  readonly #probes = new LiveShellProbes();

  constructor(inherited: Env, options: ShellEnvironmentOptions) {
    this.#options = { ...options, probes: options.probes ?? this.#probes };
    this.#inherited = { ...inherited };
    this.#key = JSON.stringify([options.platform, options.homeDirectory, inherited.SHELL ?? "", inherited.ZDOTDIR ?? ""]);
  }

  /** Applies the cached answer to target; false when there is none (or it is invalid) for this platform/home/shell. */
  installCached(target: Env): boolean {
    // v1 installIntoProcess: the host's first checks get the well-known folders even before any answer.
    this.#publish(target, { ...this.#inherited });
    let text: string;
    try {
      if (statSync(this.#options.cacheFile).size > MAX_CACHE_BYTES) return false;
      text = readFileSync(this.#options.cacheFile, "utf8");
    } catch {
      return false;
    }
    const cache = decodeCache(text);
    if (cache === undefined || cache.key !== this.#key) return false;
    const cached: Record<string, string> = {};
    for (const name of CACHED_ENV_NAMES) {
      const value = cache.environment[name];
      // mise's metadata must describe the cached PATH entries restored alongside it.
      if (name !== "PATH" && name !== "__MISE_DIFF" && this.#inherited[name] !== undefined) continue;
      if (typeof value === "string") cached[name] = value;
    }
    const baseline: Env = { ...this.#inherited };
    if (cached.PATH) cached.PATH = mergePathValues(cached.PATH, this.#inherited.PATH, this.#options.platform) ?? cached.PATH;
    Object.assign(baseline, cached);
    this.#publish(target, baseline);
    this.#hasSnapshot = true;
    return true;
  }

  /**
   * The first discovery and v1's bounded retries (30 s, 2 min, 10 min). first settles with the first
   * probe's result (what a waiting host start needs); a later success rewrites target, which the next
   * host start reads, and calls onLateAnswer so the shell can say a restart picks it up.
   */
  startDiscovery(
    target: Env,
    options: {
      readonly onLateAnswer?: () => void;
      readonly delays?: ReadonlyArray<number>;
      readonly sleep?: (ms: number) => Promise<void>;
    } = {},
  ): { readonly first: Promise<boolean>; readonly settled: Promise<boolean> } {
    let resolveFirst!: (answered: boolean) => void;
    const first = new Promise<boolean>((resolve) => (resolveFirst = resolve));
    let attempts = 0;
    const discover = async () => {
      let answered = false;
      try {
        answered = await this.refresh(target);
      } catch (error) {
        this.#options.log?.(`shell environment: ${String(error)}`);
      }
      attempts += 1;
      if (attempts === 1) resolveFirst(answered);
      else if (answered) options.onLateAnswer?.();
      return answered;
    };
    const probes = this.#options.probes ?? this.#probes;
    const settled = discoverWithRetries(discover, this.#options.platform, () => probes.allGone, {
      ...(options.delays ? { delays: options.delays } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(this.#options.log ? { log: this.#options.log } : {}),
    });
    return { first, settled };
  }

  /** Asks the login shell; true when the person's own shell answered with a PATH. */
  async refresh(target: Env): Promise<boolean> {
    // From the inherited baseline, so values the shell no longer sets do not survive.
    const fresh: Env = { ...this.#inherited };
    const prepared = await installPosixEnvironment(fresh, this.#options);
    // v1: publish when the shell answered, or when nothing better is there yet; a failed probe never
    // replaces a cached answer (a later host restart would lose the person's CLI folders).
    if (prepared || !this.#hasSnapshot) {
      this.#publish(target, fresh);
      this.#hasSnapshot = true;
    } else {
      this.#options.log?.("shell environment: login shell did not answer; keeping the cached answer");
    }
    if (prepared) {
      const environment: Record<string, string> = {};
      for (const name of CACHED_ENV_NAMES) {
        const value = fresh[name];
        if (value !== undefined) environment[name] = value;
      }
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

  /** Writes the shell-owned names of source into target (absent ones removed); PATH gets the well-known CLI folders. */
  #publish(target: Env, source: Env): void {
    for (const name of PATCH_ENV_NAMES) {
      const value = source[name];
      if (value === undefined) delete target[name];
      else target[name] = value;
    }
    const path = appendWellKnownCliDirs(target.PATH, this.#options.platform, this.#options.homeDirectory);
    if (path) target.PATH = path;
  }
}
