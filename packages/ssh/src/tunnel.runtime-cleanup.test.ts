// @effect-diagnostics nodeBuiltinImport:off - real shell and filesystem fixtures exercise deletion boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { REMOTE_RUNTIME_CLEANUP_SCRIPT, launchOrReuseRemoteServer } from "./tunnel.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { remoteShell, uploadTarget } from "./tunnel.fixture.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function fixture() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cleanup-"));
  homes.push(home);
  const versions = NodePath.join(home, ".goat/runtime/goat/versions");
  const bin = NodePath.join(home, "bin");
  NodeFS.mkdirSync(versions, { recursive: true });
  NodeFS.mkdirSync(bin);
  NodeFS.mkdirSync(NodePath.join(home, "proc/self"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(home, "proc/42"));
  const executable = (file: string, script: string) =>
    NodeFS.writeFileSync(file, script, { mode: 0o700 });
  executable(NodePath.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  executable(
    NodePath.join(bin, "ps"),
    // Cleanup must ask only for this user's processes; other users' /proc links are unreadable.
    '#!/bin/sh\ncase "$*" in *-U*) ;; *) exit 1 ;; esac\ncase "$*" in *command=*) echo unrelated ;; *pid=*) printf "42\\n${GOAT_TEST_EXTRA_PID:-}\\n" ;; *) exit 1 ;; esac\n',
  );
  NodeFS.symlinkSync("/bin/unrelated", NodePath.join(home, "proc/42/exe"));
  NodeFS.symlinkSync("/tmp", NodePath.join(home, "proc/42/cwd"));
  const semver = new URL("../../shared/src/semver.ts", import.meta.url).href;
  // Install times decide which older build is the rollback build; each add is installed later
  // than the previous one unless a test names its time.
  let installedAt = 1_700_000_000;
  const add = (v: string, at = (installedAt += 10)) => {
    const dir = NodePath.join(versions, v);
    NodeFS.mkdirSync(dir);
    NodeFS.writeFileSync(NodePath.join(dir, ".install-complete"), v + "\n");
    NodeFS.utimesSync(NodePath.join(dir, ".install-complete"), at, at);
    executable(
      NodePath.join(dir, "goat"),
      `#!${process.execPath}
(async () => {
const args = process.argv.slice(2);
if (args[1] === 'protocol') { console.log('live 2.0.0 1 1 42 1234'); return; }
if (args[1] === 'commit-time') {
  try { console.log(require('node:fs').readFileSync(__dirname + '/.commit-time', 'utf8')); return; }
  catch { process.exit(1); }
}
if (args[1] !== 'compare-version') process.exit(2);
const {compareRuntimeBuilds} = await import(${JSON.stringify(semver)});
const [a,b] = args.slice(-2);
const time = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : Number(args[i+1]); };
const order = compareRuntimeBuilds({version:a,commitTime:time('--live-commit-time')},{version:b,commitTime:time('--requested-commit-time')});
console.log(order === undefined ? 'unknown' : order > 0 ? 'newer' : order < 0 ? 'older' : 'equal');
})().catch(() => process.exit(1));\n`,
    );
  };
  for (const v of ["1.5.0", "1.6.0", "1.7.0", "1.8.0", "1.9.0", "2.0.0", "2.0.0-dev.abc", "3.0.0"])
    add(v);
  const lock = NodePath.join(home, "replacement.lock");
  NodeFS.symlinkSync("our-owner", lock);
  const run = (prefix = "") =>
    NodeChildProcess.spawnSync(remoteShell, ["-s"], {
      input: `set -eu
GOAT_HOST_WINDOWS=0; GOAT_ARCHIVE_MODE=1; LOCK_HELD=1; STATE_DIR="$HOME"
LOCK=${quote(lock)}; OWNER=our-owner; SELECTED_VERSION=2.0.0; REMOTE_PORT=1234
REQUESTED_VERSION=1.7.0; RUNNER_FILE=unused; DEFAULT_RUNTIME_FILE=unused; PORT_FILE=unused; PID_FILE=unused
read_runner_hint() { echo 1.8.0; }
valid_version() { case "$1" in *[!0-9A-Za-z.+-]*|'') return 1 ;; esac; }
valid_live_tokens() { [ "$#" = 6 ]; }
runner_sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
build_commit_time() { "$1" __ssh-helper commit-time; }
${prefix}
${REMOTE_RUNTIME_CLEANUP_SCRIPT.replaceAll("/proc/", `${home}/proc/`)}
echo connected
`,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
  return { home, versions, bin, add, run, executable };
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH runtime cleanup", () => {
  it("keeps live, retained, requested, rollback, unordered, newer, symlinks and in-use cwd; removes older unused", () => {
    const f = fixture();
    NodeFS.rmSync(NodePath.join(f.home, "proc/42/cwd"));
    NodeFS.symlinkSync(NodePath.join(f.versions, "1.6.0"), NodePath.join(f.home, "proc/42/cwd"));
    const outside = NodePath.join(f.home, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.writeFileSync(NodePath.join(outside, "keep"), "safe");
    NodeFS.symlinkSync(outside, NodePath.join(f.versions, "1.4.0"));
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.include(r.stdout, "connected");
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, "1.5.0")), r.stderr);
    for (const v of [
      "2.0.0",
      "1.9.0",
      "1.8.0",
      "1.7.0",
      "1.6.0",
      "2.0.0-dev.abc",
      "3.0.0",
      "1.4.0",
    ])
      assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, v)), v);
    assert.equal(NodeFS.readFileSync(NodePath.join(outside, "keep"), "utf8"), "safe");
    assert.isFalse(NodeFS.readdirSync(f.versions).some((v) => v.startsWith(".trash-")));
  });

  it("ignores a process that exited after ps listed it", () => {
    const f = fixture();
    const r = f.run("GOAT_TEST_EXTRA_PID=77; export GOAT_TEST_EXTRA_PID");
    assert.equal(r.status, 0, r.stderr);
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, "1.5.0")), r.stderr);
  });

  it("keeps an executable in use even when its command hides its path", () => {
    const f = fixture();
    NodeFS.rmSync(NodePath.join(f.home, "proc/42/exe"));
    NodeFS.symlinkSync(
      NodePath.join(f.versions, "1.5.0/goat"),
      NodePath.join(f.home, "proc/42/exe"),
    );
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, "1.5.0")));
  });

  it("uses verified commit stamps for dev builds to choose the rollback build", () => {
    const f = fixture();
    f.add("2.0.0-dev.old", 1);
    for (const [version, time] of [
      ["2.0.0", 3000],
      ["2.0.0-dev.abc", 2000],
      ["2.0.0-dev.old", 1000],
    ] as const) {
      const dir = NodePath.join(f.versions, version);
      NodeFS.writeFileSync(NodePath.join(dir, ".commit-time"), String(time));
      const hash = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.join(dir, "goat")))
        .digest("hex");
      NodeFS.writeFileSync(
        NodePath.join(dir, ".install-record"),
        `${version} ${"a".repeat(64)} ${hash} cache\n`,
      );
    }
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, "2.0.0-dev.abc")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, "2.0.0-dev.old")), r.stderr);
  });

  it("keeps only the rollback build installed last when older builds cannot be ordered", () => {
    const f = fixture();
    f.add("1.9.0-dev.aaa");
    f.add("1.9.0-dev.bbb");
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, "1.9.0-dev.bbb")));
    for (const v of ["1.9.0", "1.9.0-dev.aaa"])
      assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, v)), v);
  });

  it("runs without /proc or flock (macOS): lsof protects builds in use and the mutex is released", () => {
    const f = fixture();
    NodeFS.rmSync(NodePath.join(f.home, "proc"), { recursive: true });
    NodeFS.rmSync(NodePath.join(f.bin, "flock"));
    f.executable(
      NodePath.join(f.bin, "lsof"),
      `#!/bin/sh\ncase "$*" in *"-d cwd,txt"*) ;; *) exit 1 ;; esac\nprintf 'p42\\nfcwd\\nn%s\\nftxt\\nn/bin/unrelated\\n' ${quote(NodePath.join(f.versions, "1.6.0"))}\n`,
    );
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, "1.5.0")), r.stderr);
    for (const v of ["1.6.0", "1.7.0", "1.8.0", "1.9.0", "2.0.0"])
      assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, v)), v);
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, ".maintenance.lock.d")));
  });

  it("a failing lsof keeps every build", () => {
    const f = fixture();
    NodeFS.rmSync(NodePath.join(f.home, "proc"), { recursive: true });
    f.executable(NodePath.join(f.bin, "lsof"), "#!/bin/sh\nexit 1\n");
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, "1.5.0")));
  });

  it("removes staging and trash left over an hour ago and keeps fresh ones", () => {
    const f = fixture();
    // Long before this run; the fresh directory keeps the time it is created with.
    const longAgo = 1_700_000_000;
    for (const name of [".staging-old", ".trash-old", ".staging-new"]) {
      NodeFS.mkdirSync(NodePath.join(f.versions, name, "goat"), { recursive: true });
      if (name.endsWith("-old"))
        NodeFS.utimesSync(NodePath.join(f.versions, name), longAgo, longAgo);
    }
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, ".staging-old")), r.stderr);
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, ".trash-old")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, ".staging-new")));
  });

  it.each([
    "replacement",
    "rollback",
    "supervisor",
    "install",
    "mutex",
    "ps",
    "cwd",
    "windows",
    "rename",
    "delete",
    "parent-symlink",
  ])("fails closed without failing connection: %s", (kind) => {
    const f = fixture();
    let prefix = "";
    if (kind === "replacement") prefix = "LOCK_HELD=0";
    if (kind === "rollback") prefix = "UPGRADE_VERSION=1.9.0";
    if (kind === "supervisor")
      NodeFS.writeFileSync(NodePath.join(f.home, "run-t3.previous"), "rollback window");
    if (kind === "install") NodeFS.mkdirSync(NodePath.join(f.versions, ".1.4.0.install.lock"));
    if (kind === "mutex") f.executable(NodePath.join(f.bin, "flock"), "#!/bin/sh\nexit 1\n");
    if (kind === "ps") f.executable(NodePath.join(f.bin, "ps"), "#!/bin/sh\nexit 1\n");
    if (kind === "cwd") NodeFS.rmSync(NodePath.join(f.home, "proc/42/cwd"));
    if (kind === "windows") prefix = "GOAT_HOST_WINDOWS=1";
    if (kind === "rename") f.executable(NodePath.join(f.bin, "mv"), "#!/bin/sh\nexit 1\n");
    if (kind === "delete") f.executable(NodePath.join(f.bin, "rm"), "#!/bin/sh\nexit 1\n");
    if (kind === "parent-symlink") {
      const target = NodePath.join(f.home, "elsewhere");
      NodeFS.mkdirSync(target);
      NodeFS.rmSync(f.versions, { recursive: true });
      NodeFS.symlinkSync(target, f.versions);
    }
    const r = f.run(prefix);
    assert.equal(r.status, 0, r.stderr);
    assert.include(r.stdout, "connected");
    if (kind === "delete") {
      assert.isFalse(NodeFS.existsSync(NodePath.join(f.versions, "1.5.0")));
      assert.isTrue(NodeFS.readdirSync(f.versions).some((v) => v.startsWith(".trash-")));
    } else if (kind !== "parent-symlink")
      assert.isTrue(NodeFS.existsSync(NodePath.join(f.versions, "1.5.0")));
  });

  it.live("a plain attach skips cleanup and keeps older runtimes", () =>
    Effect.gen(function* () {
      const f = yield* makeProtocolFixture({
        live: true,
        kind: "managed",
        oldVersion: "1.2.3",
        ssh: SSH_RUNTIME_PROTOCOL_VERSION,
        orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      });
      const old = `${f.home}/.goat/runtime/goat/versions/1.0.0`;
      yield* f.fs.makeDirectory(old);
      let cleanupAttempted = false;
      f.setBeforeCommand((script) => {
        if (script.includes("cleanup_runtime_versions")) cleanupAttempted = true;
        return Effect.void;
      });
      const result = yield* launchOrReuseRemoteServer(uploadTarget, {}, f.runner).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
      );
      assert.equal(result.status, "ready");
      // Garbage appears only when a launch installs a runtime, so attaching costs no round trip.
      assert.isFalse(cleanupAttempted);
      assert.isTrue(yield* f.fs.exists(old));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
