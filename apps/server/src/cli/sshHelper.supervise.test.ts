// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";
import * as HostProcess from "@goat/shared/HostProcess";

import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { afterEach, assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  isLinuxZombie,
  readSshRuntimeCompatibility,
  readSshReplacementRecord,
  SSH_REPLACEMENT_RECORD_FILE,
  superviseSshRuntimeReplacement,
} from "./sshHelper.ts";

const lockModuleUrl = JSON.stringify(
  NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "..", "serverOwnerLockFile.ts")).href,
);
const tagModuleUrl = JSON.stringify(
  NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "..", "serverOwnerLock.ts")).href,
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const deadPid = () => {
  const child = NodeChildProcess.spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(String(process.pid))",
  ]);
  return Number(child.stdout.toString());
};

const spawnFailure = vi.hoisted(() => ({ sync: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // These fixtures exercise replacement/rollback with real Node processes. Windows cannot
  // execute their POSIX shebang; WMI detachment is verified separately with native executables.
  return {
    ...actual,
    spawn: (...input: Parameters<typeof actual.spawn>) => {
      const [command, args, options] = input;
      if (spawnFailure.sync) {
        spawnFailure.sync = false;
        throw new Error("injected spawn failure");
      }
      return HostProcess.Platform.defaultValue() === "win32" && command.endsWith(".mjs")
        ? actual.spawn(process.execPath, [command, ...(args ?? [])], options)
        : actual.spawn(...input);
    },
  };
});

/**
 * The target runner never becomes ready. As the failed replacement it writes "trial"; as another
 * server it takes server-owner.lock under its own tag after the backup and writes "foreign".
 */
const superviseFailedReplacement = async (
  target: "trial" | "foreign",
  options?: {
    readonly oldPid?: number;
    readonly exitTimeoutMs?: number;
    /** A forced stop of a runtime that cannot be started again leaves nothing to roll back to. */
    readonly noPrevious?: boolean;
    /** The launch already saw the old runtime exit, so its PID number proves nothing now. */
    readonly oldStopped?: boolean;
  },
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-supervise-"));
  roots.push(root);
  const userdata = NodePath.join(root, "home", "userdata");
  const stateDir = NodePath.join(root, "state");
  NodeFS.mkdirSync(userdata, { recursive: true });
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const dbPath = NodePath.join(userdata, "statev2.sqlite");
  NodeFS.writeFileSync(dbPath, "original");
  const runner = NodePath.join(stateDir, "run-t3.mjs");
  NodeFS.writeFileSync(
    runner,
    [
      `#!${process.execPath}`,
      `import * as fs from "node:fs";`,
      `import { tryAcquireServerOwnerLock } from ${lockModuleUrl};`,
      `import { serverOwnerTag } from ${tagModuleUrl};`,
      `fs.appendFileSync(${JSON.stringify(`${stateDir}/working-directories`)}, process.cwd() + "\\n");`,
      `if (process.env.GOAT_SSH_REPLACEMENT_ID) {`,
      // The replacement tags itself the way a real server does; another server uses its own tag.
      target === "foreign"
        ? `  const owner = "server:desktop";`
        : `  const owner = serverOwnerTag({ launcherContext: undefined, mode: "web", sshReplacementId: process.env.GOAT_SSH_REPLACEMENT_ID });`,
      `  const lock = tryAcquireServerOwnerLock(${JSON.stringify(userdata)}, owner);`,
      `  fs.writeFileSync(${JSON.stringify(dbPath)}, ${JSON.stringify(target)});`,
      `  fs.writeFileSync(${JSON.stringify(`${dbPath}.replacement-ran`)}, "");`,
      `  lock.release();`,
      `}`,
    ].join("\n"),
    { mode: 0o700 },
  );
  const previousRunner = NodePath.join(stateDir, "run-t3.previous.mjs");
  NodeFS.copyFileSync(runner, previousRunner);
  const result = await superviseSshRuntimeReplacement({
    oldPid: options?.oldPid ?? deadPid(),
    oldInstanceId: "old",
    port: 1,
    baseDir: NodePath.join(root, "home"),
    stateDir,
    runnerFile: runner,
    previousRunnerFile: options?.noPrevious ? "" : previousRunner,
    targetVersion: "2.0.0",
    previousVersion: options?.noPrevious ? "" : "1.0.0",
    identity: "new",
    previousIdentity: options?.noPrevious ? "" : "old",
    exitTimeoutMs: options?.exitTimeoutMs ?? 1_000,
    readyTimeoutMs: 5_000,
    logFile: NodePath.join(stateDir, "server.log"),
    ...(options?.oldStopped ? { forced: true, oldStopped: true } : {}),
  });
  return {
    result,
    ran: NodeFS.existsSync(`${dbPath}.replacement-ran`),
    database: NodeFS.readFileSync(dbPath, "utf8"),
    workingDirectories: NodeFS.readFileSync(NodePath.join(stateDir, "working-directories"), "utf8")
      .trim()
      .split("\n"),
    record: readSshReplacementRecord(
      NodeFS.readFileSync(NodePath.join(stateDir, SSH_REPLACEMENT_RECORD_FILE), "utf8"),
    ),
  };
};

it("starts replacement and rollback from the home directory", async () => {
  const { workingDirectories } = await superviseFailedReplacement("trial");
  assert.deepEqual(workingDirectories, [NodeOS.homedir(), NodeOS.homedir()]);
});

it("replacement and rollback start at root when home is an executable file", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-bad-home-"));
  roots.push(root);
  const home = NodePath.join(root, "home-file");
  NodeFS.writeFileSync(home, "", { mode: 0o700 });
  const homeKey = HostProcess.Platform.defaultValue() === "win32" ? "USERPROFILE" : "HOME";
  const previous = process.env[homeKey];
  process.env[homeKey] = home;
  try {
    const { result, workingDirectories } = await superviseFailedReplacement("trial");
    assert.equal(result.status, "failed");
    assert.deepEqual(workingDirectories, [NodePath.parse(home).root, NodePath.parse(home).root]);
  } finally {
    if (previous === undefined) delete process.env[homeKey];
    else process.env[homeKey] = previous;
  }
});

it("restores the backup over a failed replacement's own writes", async () => {
  const { result, database, ran, record } = await superviseFailedReplacement("trial");
  assert.isTrue(ran, "the replacement ran");
  assert.equal(result.status, "failed");
  assert.equal(database, "original");
  // The runtime's scheduler reads this record and never retries the target automatically.
  assert.deepInclude(record, {
    status: "failed",
    targetVersion: "2.0.0",
    previousVersion: "1.0.0",
  });
});

it("without a previous runtime, a failed replacement restores the data and starts nothing else", async () => {
  const { result, database, ran, workingDirectories } = await superviseFailedReplacement("trial", {
    noPrevious: true,
  });
  assert.isTrue(ran, "the replacement ran");
  assert.deepEqual(result, {
    status: "failed",
    reason: "GOAT 2.0.0 did not start, and no earlier runtime could be started again.",
  });
  assert.equal(database, "original");
  assert.deepEqual(workingDirectories, [NodeOS.homedir()]);
});

it("after a forced stop the launch saw complete, a live process on the old PID is not waited on", async () => {
  // The test process stands for another process that took the stopped runtime's PID.
  const { result, ran } = await superviseFailedReplacement("trial", {
    noPrevious: true,
    oldStopped: true,
    oldPid: process.pid,
  });
  assert.isTrue(ran, "the replacement ran");
  assert.equal(result.status, "failed");
});

it.each(["replacement", "rollback"] as const)(
  "after a forced stop, another server answering on the port does not confirm the %s",
  async (start) => {
    const port = await reserveLoopbackPort();
    const { baseDir, stateDir, logFile } = tempSuperviseHome();
    // A GOAT of the awaited version for other data takes the port; the child never binds it.
    const awaited = start === "replacement" ? "2.0.0" : "1.0.0";
    const descriptor = {
      environmentId: "other",
      label: "Other",
      platform: { os: "linux", arch: "x64" },
      serverVersion: awaited,
      sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      protocol: {
        ssh: { min: SSH_RUNTIME_PROTOCOL_VERSION, max: SSH_RUNTIME_PROTOCOL_VERSION },
        orchestration: { min: ORCHESTRATION_PROTOCOL_VERSION, max: ORCHESTRATION_PROTOCOL_VERSION },
      },
      capabilities: { drainRestart: true },
      instanceId: "other-instance",
    };
    const other = NodeHttp.createServer((req, res) => {
      res.writeHead(req.url === "/.well-known/goat/environment" ? 200 : 404, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(descriptor));
    });
    other.listen(port, "127.0.0.1");
    await NodeEvents.EventEmitter.once(other, "listening");
    const silent = `#!${process.execPath}\nsetInterval(() => {}, 1 << 30);\n`;
    const runnerFile = NodePath.join(stateDir, "run-t3.mjs");
    const previousRunnerFile = NodePath.join(stateDir, "previous-server.mjs");
    NodeFS.writeFileSync(
      runnerFile,
      start === "replacement" ? silent : `#!${process.execPath}\nprocess.exit(1);\n`,
      { mode: 0o700 },
    );
    if (start === "rollback") NodeFS.writeFileSync(previousRunnerFile, silent, { mode: 0o700 });
    let result: Awaited<ReturnType<typeof superviseSshRuntimeReplacement>> | undefined;
    try {
      result = await superviseSshRuntimeReplacement({
        oldPid: process.pid,
        oldInstanceId: "forced",
        port,
        baseDir,
        stateDir,
        runnerFile,
        previousRunnerFile: start === "rollback" ? previousRunnerFile : "",
        targetVersion: "2.0.0",
        previousVersion: start === "rollback" ? "1.0.0" : "",
        identity: "replacement-identity",
        previousIdentity: start === "rollback" ? "previous-identity" : "",
        exitTimeoutMs: 1_000,
        readyTimeoutMs: 2_000,
        logFile,
        forced: true,
        oldStopped: true,
      });
      assert.equal(result.status, "failed");
    } finally {
      other.close();
      // A child wrongly confirmed is still running; stop the PID the supervisor returned.
      if (result !== undefined && "pid" in result) {
        try {
          process.kill(result.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  },
);

it("keeps writes from another server that owned the data since the backup", async () => {
  const { result, database, ran } = await superviseFailedReplacement("foreign");
  assert.isTrue(ran, "the replacement ran");
  assert.equal(result.status, "failed");
  assert.equal(database, "foreign");
});

it("does not treat a sleeping Linux stat as a zombie", () => {
  assert.isFalse(isLinuxZombie(123, () => "123 (node) S 1 1"));
});

it("treats a Z state after the command as a zombie", () => {
  assert.isTrue(isLinuxZombie(123, () => "123 (node) Z 1 1"));
});

it("ignores a ') Z' sequence inside the command name", () => {
  assert.isFalse(isLinuxZombie(123, () => "123 (a) Z b) S 1 1"));
});

it("treats an unreadable stat as not a zombie", () => {
  assert.isFalse(
    isLinuxZombie(123, () => {
      throw new Error("enoent");
    }),
  );
});

const answersSignal0 = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const firstLine = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    let data = "";
    // oxlint-disable-next-line goat/no-real-time-wait-in-tests -- Watchdog rejects a real child stdout read if the owned subprocess fails to report its PID.
    const timer = setTimeout(() => reject(new Error("timed out waiting for a child pid")), 5_000);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(data.slice(0, newline));
      }
    });
  });

it.runIf(NodeFS.existsSync("/proc/self/stat"))(
  "treats an unreaped zombie old server as exited and starts the replacement",
  async () => {
    const parent = NodeChildProcess.spawn("sh", ["-c", "sleep 600 & echo $!; exec sleep 600"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      assert.isNotNull(parent.stdout);
      const zombiePid = Number((await firstLine(parent.stdout!)).trim());
      assert.isAbove(zombiePid, 0);
      process.kill(zombiePid, "SIGKILL");
      await vi.waitFor(
        () => {
          assert.isTrue(isLinuxZombie(zombiePid), "the killed child must stay an unreaped zombie");
        },
        { timeout: 2_000 },
      );
      assert.isTrue(isLinuxZombie(zombiePid), "the killed child must stay an unreaped zombie");
      assert.isTrue(answersSignal0(zombiePid), "a zombie still answers signal 0");
      const { result, ran } = await superviseFailedReplacement("trial", {
        oldPid: zombiePid,
        exitTimeoutMs: 1_000,
      });
      assert.notEqual(result.status, "old-alive");
      assert.isTrue(ran, "the replacement ran");
    } finally {
      if (parent.pid !== undefined) {
        try {
          process.kill(parent.pid, "SIGKILL");
        } catch {
          // The parent sleep already exited.
        }
      }
    }
  },
);

const tempSuperviseHome = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-supervise-"));
  roots.push(root);
  const baseDir = NodePath.join(root, "home");
  const stateDir = NodePath.join(root, "state");
  NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(baseDir, "userdata", "statev2.sqlite"), "original");
  return { baseDir, stateDir, logFile: NodePath.join(stateDir, "server.log") };
};

const record = (stateDir: string, name: string) =>
  NodeFS.readFileSync(NodePath.join(stateDir, name), "utf8");

it("passes a usable Windows working directory to replacement and rollback", async () => {
  const oldPid = deadPid();
  const { baseDir, stateDir, logFile } = tempSuperviseHome();
  const runnerFile = NodePath.join(stateDir, "run-t3.sh");
  const previousRunnerFile = NodePath.join(stateDir, "previous.sh");
  const profile = NodePath.join(stateDir, "profile");
  NodeFS.mkdirSync(profile);
  const previousProfile = process.env.USERPROFILE;
  try {
    for (const usable of [true, false]) {
      process.env.USERPROFILE = usable ? profile : NodePath.join(stateDir, "missing-profile");
      NodeFS.writeFileSync(runnerFile, "new");
      NodeFS.writeFileSync(previousRunnerFile, "old");
      using spawn = vi
        .spyOn(NodeChildProcess, "spawnSync")
        .mockReturnValue({ status: 1, stdout: "" } as ReturnType<
          typeof NodeChildProcess.spawnSync
        >);
      await superviseSshRuntimeReplacement({
        oldPid,
        oldInstanceId: "old",
        port: 1,
        baseDir,
        stateDir,
        runnerFile,
        previousRunnerFile,
        targetVersion: "2",
        previousVersion: "1",
        identity: "new",
        previousIdentity: "old",
        executable: "new.exe",
        previousExecutable: "old.exe",
        platform: "win32",
        exitTimeoutMs: 1000,
        readyTimeoutMs: 0,
        logFile,
      });
      assert.equal(spawn.mock.calls.length, 2);
      const expected = usable ? profile : NodePath.parse(baseDir).root;
      for (const call of spawn.mock.calls) {
        const options = call[2] as { env: NodeJS.ProcessEnv };
        assert.equal(options.env.GOAT_SPAWN_CWD, expected);
        assert.include(options.env.GOAT_SPAWN_ENV, "GOAT_RUNTIME_ORIGIN=ssh");
        const args = call[1] as string[];
        assert.include(
          Buffer.from(args[3]!, "base64").toString("utf16le"),
          "CurrentDirectory = $env:GOAT_SPAWN_CWD",
        );
      }
    }
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
});

it("restores the runner when refreshing its alias fails", async () => {
  const { baseDir, stateDir, logFile } = tempSuperviseHome();
  const runnerFile = NodePath.join(stateDir, "run-t3.sh");
  const previousRunnerFile = NodePath.join(stateDir, "run-t3.previous.sh");
  const alias = NodePath.join(stateDir, "run-goat.sh");
  const previousBytes = "previous runner\n";
  NodeFS.writeFileSync(runnerFile, "replacement runner\n");
  NodeFS.writeFileSync(previousRunnerFile, previousBytes);
  NodeFS.mkdirSync(alias);
  NodeFS.writeFileSync(NodePath.join(alias, "keep"), "sentinel");
  const result = await superviseSshRuntimeReplacement({
    oldPid: process.pid,
    oldInstanceId: "old-instance",
    port: 51234,
    baseDir,
    stateDir,
    runnerFile,
    previousRunnerFile,
    targetVersion: "2.0.0",
    previousVersion: "1.0.0",
    identity: "replacement-identity",
    previousIdentity: "previous-identity",
    exitTimeoutMs: 0,
    readyTimeoutMs: 1_000,
    logFile,
  });
  assert.equal(result.status, "old-alive");
  assert.equal(NodeFS.readFileSync(runnerFile, "utf8"), previousBytes);
  assert.equal(NodeFS.readFileSync(NodePath.join(alias, "keep"), "utf8"), "sentinel");
  assert.deepEqual(
    NodeFS.readdirSync(stateDir).filter((name) => name.startsWith("run-goat.sh.next.")),
    [],
  );
});

it("restores the previous runner and alias when the drained server stays alive", async () => {
  const sleep = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    const sleepPid = sleep.pid ?? 0;
    assert.isAbove(sleepPid, 0);
    const { baseDir, stateDir, logFile } = tempSuperviseHome();
    const runnerFile = NodePath.join(stateDir, "run-t3.sh");
    const alias = NodePath.join(stateDir, "run-goat.sh");
    const previousRunnerFile = NodePath.join(stateDir, "run-t3.previous.mjs");
    const previousBytes = `#!${process.execPath}\nprocess.exit(86);\n`;
    NodeFS.writeFileSync(runnerFile, `#!${process.execPath}\nprocess.exit(87);\n`, {
      mode: 0o700,
    });
    NodeFS.linkSync(runnerFile, alias);
    NodeFS.writeFileSync(previousRunnerFile, previousBytes, { mode: 0o700 });
    const previousVersion = "1.4.2";
    const previousIdentity = "previous-runner-identity";
    const port = 51234;
    for (const [name, contents] of [
      ["identity", "replacement-identity\n"],
      ["pid", "1\n"],
      ["port", "2\n"],
      ["managed", "external\n"],
    ] as const)
      NodeFS.writeFileSync(NodePath.join(stateDir, name), contents);
    const result = await superviseSshRuntimeReplacement({
      oldPid: sleepPid,
      oldInstanceId: "old-instance",
      port,
      baseDir,
      stateDir,
      runnerFile,
      previousRunnerFile,
      targetVersion: "2.0.0",
      previousVersion,
      identity: "replacement-identity",
      previousIdentity,
      exitTimeoutMs: 300,
      readyTimeoutMs: 1_000,
      logFile,
    });
    assert.equal(result.status, "old-alive");
    assert.equal(
      "reason" in result ? result.reason : "",
      `The drained GOAT ${previousVersion} (pid ${sleepPid}) did not exit; it was left running.`,
    );
    assert.isTrue(answersSignal0(sleepPid));
    assert.equal(NodeFS.readFileSync(runnerFile, "utf8"), previousBytes);
    assert.equal(NodeFS.readFileSync(alias, "utf8"), previousBytes);
    assert.isFalse(NodeFS.existsSync(previousRunnerFile));
    assert.equal(record(stateDir, "pid"), `${sleepPid}\n`);
    assert.equal(record(stateDir, "port"), `${port}\n`);
    assert.equal(record(stateDir, "identity"), `${previousIdentity}\n`);
    assert.equal(record(stateDir, "managed"), "managed\n");
  } finally {
    if (sleep.exitCode === null) {
      const stopped = NodeEvents.EventEmitter.once(sleep, "exit");
      sleep.kill("SIGKILL");
      await stopped;
    }
  }
});

const reserveLoopbackPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("expected a TCP port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

it("rolls back to a previous version whose protocol does not overlap this build", async () => {
  const previousVersion = "1.0.0";
  const ssh = SSH_RUNTIME_PROTOCOL_VERSION - 1;
  const orchestration = ORCHESTRATION_PROTOCOL_VERSION;
  const port = await reserveLoopbackPort();
  const { baseDir, stateDir, logFile } = tempSuperviseHome();
  const runnerFile = NodePath.join(stateDir, "run-t3.mjs");
  const previousRunnerFile = NodePath.join(stateDir, "previous-server.mjs");
  NodeFS.writeFileSync(runnerFile, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  NodeFS.writeFileSync(
    previousRunnerFile,
    [
      `#!${process.execPath}`,
      `import * as http from "node:http";`,
      `import * as crypto from "node:crypto";`,
      `const args = process.argv.slice(2);`,
      `const at = args.indexOf("--port");`,
      `const port = Number(args[at + 1]);`,
      `const descriptor = ${JSON.stringify({
        environmentId: "fixture",
        label: "Previous",
        platform: { os: "linux", arch: "x64" },
        serverVersion: previousVersion,
        sshRuntimeProtocolVersion: ssh,
        orchestrationProtocolVersion: orchestration,
        protocol: {
          ssh: { min: ssh, max: ssh },
          orchestration: { min: orchestration, max: orchestration },
        },
        capabilities: { drainRestart: true },
      })};`,
      `descriptor.instanceId = crypto.randomUUID();`,
      `const server = http.createServer((req, res) => {`,
      `  if (req.url === "/.well-known/goat/environment") {`,
      `    res.writeHead(200, { "content-type": "application/json" });`,
      `    res.end(JSON.stringify(descriptor));`,
      `    return;`,
      `  }`,
      `  res.writeHead(404);`,
      `  res.end();`,
      `});`,
      `server.on("error", (error) => { console.error(error); process.exit(1); });`,
      `server.listen(port, "127.0.0.1");`,
      ``,
    ].join("\n"),
    { mode: 0o700 },
  );
  let restoredPid = 0;
  // A link planted at the record's temporary name must be replaced, never written through.
  const outside = NodePath.join(baseDir, "outside");
  NodeFS.writeFileSync(outside, "keep\n");
  NodeFS.symlinkSync(outside, NodePath.join(stateDir, `started.next.${process.pid}`));
  // A backup that cannot be removed afterwards must not turn a running runtime into a failure.
  const locked = NodePath.join(stateDir, "replacement-backup", "locked");
  NodeFS.mkdirSync(locked, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(locked, "kept"), "");
  NodeFS.chmodSync(locked, 0o500);
  try {
    const result = await superviseSshRuntimeReplacement({
      oldPid: deadPid(),
      oldInstanceId: "old",
      port,
      baseDir,
      stateDir,
      runnerFile,
      previousRunnerFile,
      targetVersion: "2.0.0",
      previousVersion,
      identity: "replacement-identity",
      previousIdentity: "previous-runner-identity",
      exitTimeoutMs: 1_000,
      readyTimeoutMs: 5_000,
      logFile,
    });
    if (result.status === "rolled-back") restoredPid = result.pid;
    if (result.status !== "rolled-back") {
      const log = NodeFS.existsSync(logFile) ? NodeFS.readFileSync(logFile, "utf8") : "";
      assert.fail(`${result.status} ${"reason" in result ? result.reason : ""}\n${log}`);
    }
    assert.equal(result.status, "rolled-back");
    assert.equal("version" in result ? result.version : "", previousVersion);
    const pid = "pid" in result ? result.pid : 0;
    assert.isTrue(answersSignal0(pid));
    assert.equal(record(stateDir, "pid").trim(), String(pid));
    // Every runtime it starts gets the launch record a later forced stop asks for.
    const lstart = NodeChildProcess.execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { LC_ALL: "C", TZ: "UTC" },
    });
    assert.equal(record(stateDir, "started").trim(), lstart.trim().replace(/\s+/gu, " "));
    assert.isTrue(NodeFS.existsSync(NodePath.join(stateDir, "started.ticks")));
    assert.equal(NodeFS.readFileSync(outside, "utf8"), "keep\n");
    assert.isFalse(NodeFS.lstatSync(NodePath.join(stateDir, "started")).isSymbolicLink());
    const compat = await readSshRuntimeCompatibility(port);
    assert.equal(compat.verdict, "update-required");
    assert.equal(compat.serverVersion, previousVersion);
    assert.notEqual(compat.instanceId, "old");
  } finally {
    NodeFS.chmodSync(locked, 0o700);
    // A failing assertion must still stop the runtime the supervisor recorded.
    const recorded = NodePath.join(stateDir, "pid");
    if (restoredPid === 0 && NodeFS.existsSync(recorded))
      restoredPid = Number(NodeFS.readFileSync(recorded, "utf8").trim());
    if (restoredPid !== 0) {
      try {
        process.kill(restoredPid, "SIGKILL");
      } catch {
        // The restored server already exited.
      }
    }
  }
});

it.each(["sync", "async"] as const)(
  "restores the runner after a %s spawn failure",
  async (mode) => {
    const { baseDir, stateDir, logFile } = tempSuperviseHome();
    const runnerFile = NodePath.join(stateDir, "run-t3.mjs");
    const previousRunnerFile = NodePath.join(stateDir, "previous.mjs");
    const previous = `#!${process.execPath}\nprocess.exit(1);\n`;
    NodeFS.writeFileSync(previousRunnerFile, previous, { mode: 0o700 });
    if (mode === "sync") NodeFS.writeFileSync(runnerFile, previous, { mode: 0o700 });
    spawnFailure.sync = mode === "sync";
    try {
      const result = await superviseSshRuntimeReplacement({
        oldPid: deadPid(),
        oldInstanceId: "old",
        port: 1,
        baseDir,
        stateDir,
        runnerFile,
        previousRunnerFile,
        targetVersion: "2.0.0",
        previousVersion: "1.0.0",
        identity: "new",
        previousIdentity: "old",
        exitTimeoutMs: 1000,
        readyTimeoutMs: 5000,
        logFile,
      });
      assert.deepEqual(result, {
        status: "failed",
        reason: "GOAT 2.0.0 and the previous 1.0.0 both failed to start.",
      });
      assert.equal(NodeFS.readFileSync(runnerFile, "utf8"), previous);
    } finally {
      spawnFailure.sync = false;
    }
  },
);

it("records a supervisor that throws as a failed replacement", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-supervise-"));
  roots.push(root);
  const stateDir = NodePath.join(root, "state");
  NodeFS.mkdirSync(stateDir);
  // A base directory that is a file makes creating userdata throw.
  const baseDir = NodePath.join(root, "not-a-directory");
  NodeFS.writeFileSync(baseDir, "");
  const result = await superviseSshRuntimeReplacement({
    oldPid: deadPid(),
    oldInstanceId: "old",
    port: 1,
    baseDir,
    stateDir,
    runnerFile: NodePath.join(stateDir, "run-t3.sh"),
    previousRunnerFile: NodePath.join(stateDir, "run-t3.previous"),
    targetVersion: "2.0.0",
    previousVersion: "1.0.0",
    identity: "new",
    previousIdentity: "old",
    exitTimeoutMs: 1_000,
    readyTimeoutMs: 1_000,
    logFile: NodePath.join(stateDir, "server.log"),
  });
  assert.equal(result.status, "failed");
  assert.deepInclude(
    readSshReplacementRecord(
      NodeFS.readFileSync(NodePath.join(stateDir, SSH_REPLACEMENT_RECORD_FILE), "utf8"),
    ),
    { status: "failed", targetVersion: "2.0.0" },
  );
});

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "a replacement that exits before it is ready is never signalled by PID",
  async () => {
    const { baseDir, stateDir, logFile } = tempSuperviseHome();
    const runnerFile = NodePath.join(stateDir, "run-t3.mjs");
    NodeFS.writeFileSync(runnerFile, `#!${process.execPath}\nprocess.exit(3);\n`, { mode: 0o700 });
    // The child is reaped as it exits, and its PID is then taken by another process: nothing may
    // be signalled by that number.
    const oldPid = deadPid();
    const sent: Array<string | number | undefined> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 || signal === undefined) {
        if (pid === oldPid) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      }
      sent.push(signal);
      return true;
    });
    try {
      const result = await superviseSshRuntimeReplacement({
        oldPid,
        oldInstanceId: "old",
        port: 1,
        baseDir,
        stateDir,
        runnerFile,
        previousRunnerFile: "",
        targetVersion: "2.0.0",
        previousVersion: "",
        identity: "new",
        previousIdentity: "",
        exitTimeoutMs: 1000,
        readyTimeoutMs: 1000,
        logFile,
      });
      assert.equal(result.status, "failed");
      assert.deepEqual(sent, []);
    } finally {
      kill.mockRestore();
    }
  },
);
