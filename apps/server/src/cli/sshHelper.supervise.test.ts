// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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

/**
 * The target runner never becomes ready. As the failed replacement it writes "trial"; as another
 * server it takes server-owner.lock under its own tag after the backup and writes "foreign".
 */
const superviseFailedReplacement = async (
  target: "trial" | "foreign",
  options?: { readonly oldPid?: number; readonly exitTimeoutMs?: number },
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
    previousRunnerFile: previousRunner,
    targetVersion: "2.0.0",
    previousVersion: "1.0.0",
    identity: "new",
    previousIdentity: "old",
    exitTimeoutMs: options?.exitTimeoutMs ?? 1_000,
    readyTimeoutMs: 5_000,
    logFile: NodePath.join(stateDir, "server.log"),
  });
  return {
    result,
    ran: NodeFS.existsSync(`${dbPath}.replacement-ran`),
    database: NodeFS.readFileSync(dbPath, "utf8"),
    record: readSshReplacementRecord(
      NodeFS.readFileSync(NodePath.join(stateDir, SSH_REPLACEMENT_RECORD_FILE), "utf8"),
    ),
  };
};

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

it("restores the previous runner when the drained server stays alive", async () => {
  const sleep = NodeChildProcess.spawn("sleep", ["600"], { stdio: "ignore" });
  try {
    const sleepPid = sleep.pid ?? 0;
    assert.isAbove(sleepPid, 0);
    const { baseDir, stateDir, logFile } = tempSuperviseHome();
    const runnerFile = NodePath.join(stateDir, "run-t3.mjs");
    const previousRunnerFile = NodePath.join(stateDir, "run-t3.previous.mjs");
    const previousBytes = `#!${process.execPath}\nprocess.exit(86);\n`;
    NodeFS.writeFileSync(runnerFile, `#!${process.execPath}\nprocess.exit(87);\n`, {
      mode: 0o700,
    });
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
    assert.isFalse(NodeFS.existsSync(previousRunnerFile));
    assert.equal(record(stateDir, "pid"), `${sleepPid}\n`);
    assert.equal(record(stateDir, "port"), `${port}\n`);
    assert.equal(record(stateDir, "identity"), `${previousIdentity}\n`);
    assert.equal(record(stateDir, "managed"), "managed\n");
  } finally {
    if (sleep.pid !== undefined) {
      try {
        process.kill(sleep.pid, "SIGKILL");
      } catch {
        // The sleep already exited.
      }
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
    const compat = await readSshRuntimeCompatibility(port);
    assert.equal(compat.verdict, "update-required");
    assert.equal(compat.serverVersion, previousVersion);
    assert.notEqual(compat.instanceId, "old");
  } finally {
    if (restoredPid !== 0) {
      try {
        process.kill(restoredPid, "SIGKILL");
      } catch {
        // The restored server already exited.
      }
    }
  }
});

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
