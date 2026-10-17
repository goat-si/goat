// @effect-diagnostics nodeBuiltinImport:off - runs at test setup and process exit, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Temp entries with this prefix are GOAT's own; one left in a sandbox is a test leak. */
export const LEAK_PREFIX = "goat-";
const SANDBOX_PREFIX = "goat-test-";
/** The temp directory the first sandbox was made in, so a reused worker never nests sandboxes. */
const PARENT_ENV = "GOAT_TEST_PARENT_TMPDIR";
/** "fail" turns a leak into a failed test file; anything else only prints it. CI sets "fail". */
export const GUARD_ENV = "GOAT_TEST_TMP_GUARD";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Where a test file's sandbox goes, given the temp directory it inherited.
 *
 * macOS's per-user temp directory is already long (/private/var/folders/xx/…/T), and one more
 * segment pushes Unix socket paths past the 104-byte sun_path limit, so sockets fail with EINVAL.
 * Only that default moves under /tmp. A TMPDIR the caller chose, such as a CI job's own temp
 * directory, is kept so the job's cleanup and leak check still see the sandbox.
 */
export const sandboxParentFor = (
  platform: NodeJS.Platform,
  inherited: string,
  resolveTmp: () => string,
): string => {
  if (platform !== "darwin" || !/^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/?$/.test(inherited))
    return inherited;
  try {
    return resolveTmp();
  } catch {
    return inherited;
  }
};

const sandboxParent = (): string =>
  sandboxParentFor(
    // oxlint-disable-next-line goat/no-global-process-runtime -- Same reason as below: HostProcess cannot load in every test config.
    NodeOS.platform(),
    NodeOS.tmpdir(),
    () => NodeFS.realpathSync.native("/tmp"),
  );

export interface TestTempSandbox {
  readonly directory: string;
  /** Restores TMPDIR, deletes the sandbox, and returns the leaked goat-* entries it held. */
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
 * Point TMPDIR at a fresh directory for the rest of this test file.
 *
 * Everything that honors os.tmpdir(), including spawned servers that inherit the
 * environment, then writes inside it. Closing the sandbox reports what a test left
 * behind and deletes it; process exit and termination signals delete it too, so a
 * crashed or interrupted worker does not leave its temp files on the host.
 *
 * Windows keeps its temp directory: MAX_PATH leaves no room for another segment.
 */
export const enterTestTempSandbox = (): TestTempSandbox | undefined => {
  // oxlint-disable-next-line goat/no-global-process-runtime -- Every test config loads this setup, and HostProcess imports node:sea, which mobile tests cannot bundle.
  if (NodeOS.platform() === "win32") return undefined;

  const previous = process.env.TMPDIR;
  const parent = process.env[PARENT_ENV] ?? sandboxParent();
  const directory = NodeFS.mkdtempSync(NodePath.join(parent, SANDBOX_PREFIX));
  process.env[PARENT_ENV] = parent;
  process.env.TMPDIR = directory;

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
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
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
