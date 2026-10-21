// @effect-diagnostics nodeBuiltinImport:off - runs at test setup and process exit, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Temp entries with this prefix are GOAT's own; one left in a sandbox is a test leak. */
const LEAK_PREFIX = "goat-";
const SANDBOX_PREFIX = "goat-test-";
/** The temp directory the first sandbox was made in, so a reused worker never nests sandboxes. */
const PARENT_ENV = "GOAT_TEST_PARENT_TMPDIR";
/** "fail" turns a leak into a failed test file; anything else only prints it. CI sets "fail". */
export const GUARD_ENV = "GOAT_TEST_TMP_GUARD";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const WINDOWS_TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const POSIX_TEMP_ENV_KEYS = ["TMPDIR"] as const;

/**
 * macOS's `sockaddr_un.sun_path` holds 104 bytes including the terminating NUL.
 * The longest Unix socket a test binds inside its sandbox is
 * `<sandbox>/t3code-<user key>/<24-hex>.sock` (`packages/shared/src/desktopAppControl.ts`),
 * where the user key is the UID (up to 10 digits) or a 12-hex hash when there is none.
 */
const DARWIN_SUN_PATH_BYTES = 103;
const LONGEST_SANDBOX_SOCKET_RELATIVE_PATH = NodePath.posix.join(
  `${SANDBOX_PREFIX}XXXXXX`,
  `t3code-${"0".repeat(12)}`,
  `${"0".repeat(24)}.sock`,
);

/**
 * Where a test file's sandbox goes, given the temp directory it inherited.
 *
 * A caller-chosen `TMPDIR`, such as a CI job's private temp directory, is kept whenever
 * Unix sockets inside the sandbox still fit `sun_path`. When the inherited path is so
 * long that adding the sandbox segment would push socket paths past macOS's 104-byte
 * `sun_path` limit (as macOS's `/private/var/folders/xx/…/T` default does), the sandbox
 * falls back to `/tmp` so socket tests do not fail with `EINVAL`.
 */
export const sandboxParentFor = (
  platform: NodeJS.Platform,
  inherited: string,
  resolveTmp: () => string,
): string => {
  if (
    platform !== "darwin" ||
    Buffer.byteLength(NodePath.posix.join(inherited, LONGEST_SANDBOX_SOCKET_RELATIVE_PATH)) <=
      DARWIN_SUN_PATH_BYTES
  ) {
    return inherited;
  }
  try {
    const fallback = resolveTmp();
    return Buffer.byteLength(fallback) < Buffer.byteLength(inherited) ? fallback : inherited;
  } catch {
    return inherited;
  }
};

const sandboxParent = (platform: NodeJS.Platform): string =>
  sandboxParentFor(platform, NodeOS.tmpdir(), () => NodeFS.realpathSync.native("/tmp"));

export interface TestTempSandbox {
  readonly directory: string;
  /** Restores the process temp env, deletes the sandbox, and returns the leaked goat-* entries it held. */
  readonly close: () => ReadonlyArray<string>;
}

const removeQuietly = (path: string) => {
  try {
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort: a process exiting must not throw over a temp directory.
  }
};

/**
 * Point `os.tmpdir()` at a fresh directory for the rest of this test file.
 *
 * Everything that honors os.tmpdir(), including spawned servers that inherit the
 * environment, then writes inside it. Closing the sandbox reports what a test left
 * behind and deletes it; process exit and termination signals delete it too, so a
 * crashed or interrupted worker does not leave its temp files on the host.
 */
export const enterTestTempSandbox = (
  // oxlint-disable-next-line goat/no-global-process-runtime -- Every test config loads this setup, and HostProcess imports node:sea, which mobile tests cannot bundle.
  platform: NodeJS.Platform = NodeOS.platform(),
): TestTempSandbox => {
  const keys = platform === "win32" ? WINDOWS_TEMP_ENV_KEYS : POSIX_TEMP_ENV_KEYS;
  const previousEnv = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]]),
  );
  const previousParent = process.env[PARENT_ENV];
  const currentTmp = NodeOS.tmpdir();
  const parent =
    NodePath.basename(currentTmp).startsWith(SANDBOX_PREFIX) && previousParent !== undefined
      ? previousParent
      : sandboxParent(platform);
  const directory = NodeFS.mkdtempSync(NodePath.join(parent, SANDBOX_PREFIX));
  process.env[PARENT_ENV] = parent;
  for (const key of keys) {
    process.env[key] = directory;
  }

  const onExit = () => removeQuietly(directory);
  const onSignal = (signal: NodeJS.Signals) => {
    removeQuietly(directory);
    // Our listener suppresses the default exit. Re-raise only when nobody else handles it.
    if (process.listenerCount(signal) === 1) {
      detach();
      process.kill(process.pid, signal);
    }
  };
  const detach = () => {
    process.off("exit", onExit);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
  process.on("exit", onExit);
  for (const signal of SIGNALS) process.on(signal, onSignal);

  return {
    directory,
    close: () => {
      detach();
      if (previousParent === undefined) delete process.env[PARENT_ENV];
      else process.env[PARENT_ENV] = previousParent;
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      let leaked: string[] = [];
      try {
        leaked = NodeFS.readdirSync(directory).filter((name) => name.startsWith(LEAK_PREFIX));
      } catch {
        // A test that deleted the sandbox itself leaked nothing into it.
      }
      removeQuietly(directory);
      return leaked.sort();
    },
  };
};

/** The guard's report, worded for a CI log. */
export const describeLeaks = (leaked: ReadonlyArray<string>): string =>
  [
    `This test file left ${leaked.length} ${LEAK_PREFIX}* temp entr${leaked.length === 1 ? "y" : "ies"} behind.`,
    "Delete them in afterEach/afterAll, or create them with a scoped helper such as makeTempDirectoryScoped:",
    ...leaked.map((name) => `  ${name}`),
  ].join("\n");
