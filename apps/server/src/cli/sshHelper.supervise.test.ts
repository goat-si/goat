// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, assert, it } from "@effect/vitest";

import { superviseSshRuntimeReplacement } from "./sshHelper.ts";

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
const superviseFailedReplacement = async (target: "trial" | "foreign") => {
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
    oldPid: deadPid(),
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
    exitTimeoutMs: 1_000,
    readyTimeoutMs: 5_000,
    logFile: NodePath.join(stateDir, "server.log"),
  });
  assert.isTrue(NodeFS.existsSync(`${dbPath}.replacement-ran`), "the replacement ran");
  return { result, database: NodeFS.readFileSync(dbPath, "utf8") };
};

it("restores the backup over a failed replacement's own writes", async () => {
  const { result, database } = await superviseFailedReplacement("trial");
  assert.equal(result.status, "failed");
  assert.equal(database, "original");
});

it("keeps writes from another server that owned the data since the backup", async () => {
  const { result, database } = await superviseFailedReplacement("foreign");
  assert.equal(result.status, "failed");
  assert.equal(database, "foreign");
});
