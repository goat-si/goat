// @effect-diagnostics nodeBuiltinImport:off - runs setup's directory step in a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import { onTestFinished } from "vite-plus/test";

import {
  isCorepackLauncherMissing,
  pinnedNodeRunners,
  worktreeInstallCandidates,
  vpSupportsVerifiedNodeDownload,
} from "./setup-worktree.ts";

describe("worktreeInstallCandidates", () => {
  it("prefers vp, then pnpm and never adds an installer", () => {
    const vp = { command: "vp i --frozen-lockfile", tool: "vp" };
    const pnpm = { command: "pnpm install --frozen-lockfile", tool: "pnpm" };
    assert.deepEqual(worktreeInstallCandidates({ vp: true, pnpm: true }), [vp, pnpm]);
    assert.deepEqual(worktreeInstallCandidates({ vp: false, pnpm: true }), [pnpm]);
    assert.deepEqual(worktreeInstallCandidates({ vp: false, pnpm: false }), []);
  });
});

it("only offers a verified vp runner when downloads are enabled", () => {
  const vp = {
    command: "vp env exec --node 26.12.1 -- node scripts/setup-worktree.ts",
    tool: "vp",
  };
  assert.deepEqual(pinnedNodeRunners({ pinned: "26.12.1", vp: true, autoDownload: true }), [vp]);
  assert.deepEqual(pinnedNodeRunners({ pinned: "26.12.1", vp: false, autoDownload: true }), []);
  assert.deepEqual(pinnedNodeRunners({ pinned: "26.12.1", vp: true, autoDownload: false }), []);
});

it("recognizes only missing corepack pnpm launchers", () => {
  assert.isTrue(
    isCorepackLauncherMissing("Cannot find module 'C:\\cache\\corepack\\v1\\pnpm\\bin\\pnpm.cjs'"),
  );
  assert.isFalse(
    isCorepackLauncherMissing("Cannot find module '/x/corepack/v1/pnpm/bin/other.cjs'"),
  );
  assert.isFalse(isCorepackLauncherMissing("Cannot find module '/x/project/bin/pnpm.cjs'"));
  assert.isFalse(isCorepackLauncherMissing("ERR_PNPM_OUTDATED_LOCKFILE"));
});

function setupFixture(
  pinned: string,
  pnpmOutput: string,
  trailingLines = 0,
  runnerMode: "installer" | "runs-node" | "hangs" = "installer",
  vp: "absent" | "wrong-node" | "partial-result" = "absent",
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-setup-contract-"));
  const scripts = NodePath.join(root, "scripts");
  const bin = NodePath.join(root, "bin");
  const log = NodePath.join(root, "install.log");
  NodeFS.mkdirSync(NodePath.join(scripts, "lib"), { recursive: true });
  NodeFS.mkdirSync(bin);
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "setup-worktree.ts"),
    NodePath.join(scripts, "setup-worktree.ts"),
  );
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "lib", "node-runtime.ts"),
    NodePath.join(scripts, "lib", "node-runtime.ts"),
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "package.json"),
    JSON.stringify({ type: "module", engines: { node: pinned }, packageManager: "pnpm@12.14.0" }),
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "pnpm-workspace.yaml"),
    "catalog:\n  vite-plus: 1.4.0\n",
  );
  const windows = HostProcess.Platform.defaultValue() === "win32";
  const nodeRunner = `printf '%s' "$SETUP_TEST_PIN" > package.json; export SETUP_TEST_RERUN_PID=$$; exec "$SETUP_TEST_NODE" "$7"`;
  const hangingRunner = `"$(dirname "$0")/vp-child" &\nwait`;
  if (runnerMode === "hangs") {
    NodeFS.writeFileSync(
      NodePath.join(bin, "vp-child"),
      `#!/bin/sh\ntrap 'printf "%s\\n" grandchild-signalled >> "$SETUP_TEST_LOG"; exit 0' TERM\nprintf 'ready %s\\n' "$$"\nwhile :; do sleep 1; done\n`,
      { mode: 0o755 },
    );
  }
  if (vp !== "absent" || runnerMode !== "installer") {
    const runner =
      vp === "wrong-node"
        ? `"$SETUP_TEST_NODE" "$7"; code=$?; ls .goat | tr '\\n' ' ' >> "$SETUP_TEST_LOG.markers"; exit $code`
        : vp === "partial-result"
          ? `printf 'fai' > ".goat/setup-rerun-$GOAT_SETUP_PINNED_NODE"; exit 1`
          : runnerMode === "hangs"
            ? hangingRunner
            : nodeRunner;
    NodeFS.writeFileSync(
      NodePath.join(bin, "vp"),
      `#!/bin/sh\nif [ "$1" = "--version" ] && [ -n "$SETUP_TEST_USE_CUSTOM_VERSION" ]; then printf '%s' "$SETUP_TEST_CUSTOM_VERSION"; exit \${SETUP_TEST_VERSION_EXIT:-0}; fi\nif [ "$1" = "--version" ]; then : > "$SETUP_TEST_LOG.version"; printf 'vp v%s\\n' "\${SETUP_TEST_VP_VERSION:-1.5.0}"; exit 0; fi\nprintf 'vp %s\\n' "$1" >> "$SETUP_TEST_LOG"\nif [ "$1" = "env" ]; then ${runner}; fi\nif [ -n "$SETUP_TEST_KILL_RERUN" ]; then kill -9 "$SETUP_TEST_RERUN_PID"; fi\nif [ -n "$SETUP_TEST_VP_FAIL" ]; then printf '%s\\n' "$SETUP_TEST_VP_FAIL" >&2; exit 3; fi\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  for (const name of ["pnpm", "npx"] as const) {
    const noise = "x".repeat(60);
    const contents = windows
      ? `@echo off\r\necho ${name}>>"%SETUP_TEST_LOG%"\r\necho ${pnpmOutput} 1>&2\r\nexit /b 1\r\n`
      : `#!/bin/sh\nprintf '%s\n' '${name}' >> "$SETUP_TEST_LOG"\nprintf '%s\n' "${pnpmOutput}" >&2\ni=0\nwhile [ "$i" -lt ${trailingLines} ]; do printf '%s\n' '${noise}' >&2; i=$((i + 1)); done\nexit \${SETUP_TEST_PNPM_EXIT:-1}\n`;
    NodeFS.writeFileSync(NodePath.join(bin, `${name}${windows ? ".cmd" : ""}`), contents, {
      mode: 0o755,
    });
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const path = windows
    ? [bin, NodePath.join(systemRoot, "System32"), systemRoot]
    : [bin, "/usr/bin", "/bin"];
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: path.join(NodePath.delimiter),
    GOAT_PROJECT_ROOT: root,
    SETUP_TEST_LOG: log,
    SETUP_TEST_NODE: process.execPath,
    SETUP_TEST_PIN: JSON.stringify({
      type: "module",
      engines: { node: process.versions.node },
      packageManager: "pnpm@12.14.0",
    }),
  };
  return {
    root,
    log,
    env,
    script: NodePath.join(scripts, "setup-worktree.ts"),
    run: () =>
      NodeChildProcess.spawnSync(process.execPath, [NodePath.join(scripts, "setup-worktree.ts")], {
        cwd: root,
        env,
        encoding: "utf8",
      }),
    cleanup: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "kills a timed-out probe and its descendant holding stdout open",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-vp-probe-"));
    const executable = NodePath.join(root, "vp");
    const parentFile = NodePath.join(root, "parent");
    const childFile = NodePath.join(root, "child");
    const fifo = NodePath.join(root, "exit-pipe");
    NodeChildProcess.execFileSync("mkfifo", [fifo]);
    const reader = NodeChildProcess.spawn("cat", [fifo], { stdio: "ignore" });
    const readerExited = new Promise<number | null>((resolve) => reader.on("exit", resolve));
    let writer: number | undefined = NodeFS.openSync(fifo, "w");
    const childScript = NodePath.join(root, "child.sh");
    NodeFS.writeFileSync(
      childScript,
      `#!/bin/sh
trap '' TERM
printf '%s' "$$" > ${JSON.stringify(childFile)}
sleep 60 &
wait
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      executable,
      `#!/bin/sh
trap '' TERM
printf '%s' "$$" > ${JSON.stringify(parentFile)}
exec 3> ${JSON.stringify(fifo)}
${JSON.stringify(childScript)} &
printf 'vp v0.2.2\\n'
sleep 60 &
wait
`,
      { mode: 0o755 },
    );
    const pidFiles = [parentFile, childFile];
    try {
      const result = vpSupportsVerifiedNodeDownload(2_000, executable);
      for (const file of pidFiles)
        assert.isTrue(NodeFS.existsSync(file), `stand-in PID file missing: ${file}`);
      const pids = pidFiles.map((file) => Number(NodeFS.readFileSync(file, "utf8")));
      assert.isFalse(result.supported);
      assert.isTrue(result.timedOut);
      NodeFS.closeSync(writer);
      writer = undefined;
      assert.equal(await readerExited, 0);
      for (const pid of pids)
        assert.throws(() => process.kill(pid, 0), undefined, undefined, `process ${pid} survived`);
    } finally {
      if (writer !== undefined) NodeFS.closeSync(writer);
      for (const file of pidFiles) {
        if (!NodeFS.existsSync(file)) continue;
        const pid = Number(NodeFS.readFileSync(file, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) continue;
        for (const target of file === parentFile ? [-pid, pid] : [pid]) {
          try {
            process.kill(target, "SIGKILL");
          } catch {}
        }
      }
      await readerExited;
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("worktree setup contract", () => {
  it("#2178 refuses an unsupported Node it cannot replace, before running any installer", () => {
    const [major = 0] = process.versions.node.split(".").map(Number);
    const fixture = setupFixture(`${major + 1}.0.0`, "unexpected install");
    try {
      const locator =
        HostProcess.Platform.defaultValue() === "win32"
          ? NodeChildProcess.spawnSync("where", ["pnpm"], { env: fixture.env, encoding: "utf8" })
          : NodeChildProcess.spawnSync("/bin/sh", ["-c", "command -v pnpm"], {
              env: fixture.env,
              encoding: "utf8",
            });
      assert.equal(locator.status, 0, locator.stderr);
      const result = fixture.run();
      assert.equal(result.status, 1, result.stderr);
      const failed = NodeFS.readFileSync(
        NodePath.join(fixture.root, ".goat", "setup-failed"),
        "utf8",
      );
      assert.include(failed, "GOAT development uses Node.js");
      assert.include(failed, `Install Node.js ${major + 1}.0.0`);
      assert.isFalse(NodeFS.existsSync(fixture.log));
      assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-running")));
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "sets up under the pinned Node using vp",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(
        `${major + 1}.0.0`,
        "Error: Cannot find module '/x/.cache/node/corepack/v1/pnpm/12.14.0/bin/pnpm.cjs'",
        0,
        "runs-node",
      );
      try {
        const result = fixture.run();
        assert.equal(result.status, 0, result.stderr);
        assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-done")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-failed")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-running")));
        assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
          "vp env",
          "vp i",
        ]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refuses when vp runs setup under a Node that is still not supported",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(
        `${major + 1}.0.0`,
        "unexpected install",
        0,
        "runs-node",
        "wrong-node",
      );
      try {
        const result = fixture.run();
        assert.equal(result.status, 1, result.stderr);
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-done")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-failed")));
        const between = NodeFS.readFileSync(`${fixture.log}.markers`, "utf8");
        assert.include(between, "setup-running");
        assert.notInclude(between, "setup-failed");
        assert.notInclude(between, "setup-done");
        assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
          "vp env",
        ]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "an installer that fails under the rerun ends setup with its own error, whatever its exit code",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(
        `${major + 1}.0.0`,
        "ERR_PNPM_OUTDATED_LOCKFILE",
        0,
        "runs-node",
      );
      fixture.env.SETUP_TEST_VP_FAIL = "ERR_PNPM_OUTDATED_LOCKFILE";
      try {
        const result = fixture.run();
        assert.equal(result.status, 3, result.stderr);
        const state = NodePath.join(fixture.root, ".goat");
        const failed = NodeFS.readFileSync(NodePath.join(state, "setup-failed"), "utf8");
        assert.include(failed, "ERR_PNPM_OUTDATED_LOCKFILE");
        assert.notInclude(failed, "could not start itself");
        assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-done")));
        assert.deepEqual(
          NodeFS.readdirSync(state).filter((name) => name.startsWith("setup-rerun-")),
          [],
        );
        assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
          "vp env",
          "vp i",
        ]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a rerun killed mid-install ends setup as failed and no other runner installs again",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(`${major + 1}.0.0`, "install was running", 0, "runs-node");
      fixture.env.SETUP_TEST_KILL_RERUN = "1";
      try {
        const result = fixture.run();
        assert.notEqual(result.status, 0, result.stderr);
        const state = NodePath.join(fixture.root, ".goat");
        assert.include(
          NodeFS.readFileSync(NodePath.join(state, "setup-failed"), "utf8"),
          "ended without finishing",
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-done")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-running")));
        assert.deepEqual(
          NodeFS.readdirSync(state).filter((name) => name.startsWith("setup-rerun-")),
          [],
        );
        assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
          "vp env",
          "vp i",
        ]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a rerun whose outcome is unreadable ends setup as failed and no other runner is tried",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(
        `${major + 1}.0.0`,
        "unexpected install",
        0,
        "runs-node",
        "partial-result",
      );
      try {
        const result = fixture.run();
        assert.equal(result.status, 1, result.stderr);
        const state = NodePath.join(fixture.root, ".goat");
        assert.include(
          NodeFS.readFileSync(NodePath.join(state, "setup-failed"), "utf8"),
          "Setup under vp ended without finishing.",
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-done")));
        assert.deepEqual(
          NodeFS.readdirSync(state).filter((name) => name.startsWith("setup-rerun-")),
          [],
        );
        assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
          "vp env",
        ]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("a rerun flag with no setup behind it changes nothing: the run owns its markers", () => {
    const fixture = setupFixture(process.versions.node, "ERR_PNPM_OUTDATED_LOCKFILE");
    fixture.env.GOAT_SETUP_PINNED_NODE = "1";
    const state = NodePath.join(fixture.root, ".goat");
    NodeFS.mkdirSync(state);
    NodeFS.writeFileSync(NodePath.join(state, "setup-done"), "");
    try {
      const result = fixture.run();
      assert.equal(result.status, 1, result.stderr);
      assert.include(
        NodeFS.readFileSync(NodePath.join(state, "setup-failed"), "utf8"),
        "ERR_PNPM_OUTDATED_LOCKFILE",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-done")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-running")));
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a cancel reaches everything the pinned-Node rerun started, and leaves only setup-failed",
    async () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(`${major + 1}.0.0`, "unexpected install", 0, "hangs");
      const setup = NodeChildProcess.spawn(process.execPath, [fixture.script], {
        cwd: fixture.root,
        env: fixture.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let grandchild: number | undefined;
      // Runs on a timeout too, where a finally block would not: nothing started here may outlive the test.
      onTestFinished(() => {
        for (const pid of [setup.pid, grandchild]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        fixture.cleanup();
      });
      setup.stdout.setEncoding("utf8");
      const exited = new Promise<number | null>((resolve) => setup.on("exit", resolve));
      let seen = "";
      await new Promise<void>((resolve, reject) => {
        setup.on("exit", (code) =>
          reject(new Error(`setup exited with ${code} before its runner was ready`)),
        );
        setup.stdout.on("data", (chunk: string) => {
          seen += chunk;
          const ready = /ready (\d+)/.exec(seen);
          if (ready === null || grandchild !== undefined) return;
          grandchild = Number(ready[1]);
          resolve();
        });
      });
      setup.kill("SIGTERM");
      assert.notEqual(await exited, 0);
      const state = NodePath.join(fixture.root, ".goat");
      assert.include(
        NodeFS.readFileSync(NodePath.join(state, "setup-failed"), "utf8"),
        "Cancelled by SIGTERM.",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-done")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(state, "setup-running")));
      assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
        "vp env",
        "grandchild-signalled",
      ]);
    },
  );

  it("#2178 diagnoses corepack's missing pnpm launcher", () => {
    const fixture = setupFixture(
      process.versions.node,
      "Error: Cannot find module '/x/.cache/node/corepack/v1/pnpm/12.14.0/bin/pnpm.cjs'",
    );
    try {
      const result = fixture.run();
      assert.equal(result.status, 1, result.stderr);
      assert.include(result.stderr, "Corepack shim whose launcher is missing");
      assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), ["pnpm"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("#2178 diagnoses a missing launcher even when later output fills the marker tail", () => {
    const fixture = setupFixture(
      process.versions.node,
      "Error: Cannot find module '/x/.cache/node/corepack/v1/pnpm/12.14.0/bin/pnpm.cjs'",
      200,
    );
    try {
      const result = fixture.run();
      assert.equal(result.status, 1, result.stderr);
      assert.include(result.stderr, "Corepack shim whose launcher is missing");
      assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), ["pnpm"]);
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a timed-out version probe leaves failure guidance and clears the running marker",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(`${major + 1}.0.0`, "unexpected", 0, "runs-node");
      const preload = NodePath.join(fixture.root, "probe.cjs");
      NodeFS.writeFileSync(
        preload,
        `const cp = require("node:child_process");
const original = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  if (command === "vp" && args[0] === "--version") {
    require("node:fs").writeFileSync(process.env.SETUP_TEST_LOG + ".timeout", String(options.timeout));
    require("node:fs").writeSync(options.stdio[1], "vp v0.2.2\\n");
    return { status: 0, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  }
  return original.apply(this, arguments);
};
require("node:module").syncBuiltinESMExports();`,
      );
      fixture.env.NODE_OPTIONS = `--require=${preload}`;
      try {
        const result = fixture.run();
        assert.equal(result.status, 1);
        const failed = NodeFS.readFileSync(
          NodePath.join(fixture.root, ".goat", "setup-failed"),
          "utf8",
        );
        assert.include(failed, "vp did not answer");
        assert.match(failed, /update vite-plus/i);
        assert.isAbove(Number(NodeFS.readFileSync(`${fixture.log}.timeout`, "utf8")), 0);
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-running")));
        assert.isFalse(NodeFS.existsSync(fixture.log));
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "accepts only a stable vp version in the exact expected format",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      for (const [output, accepted, exit] of [
        ["vp v0.2.2", true, 0],
        ["vp v0.2.2\n", true, 0],
        ["vp v0.2.10\r\n", true, 0],
        ["vp v1.0.0\n", true, 0],
        ["vp v0.2.1\n", false, 0],
        ["vp v0.2.2-beta.1\n", false, 0],
        ["vp v0.3.0-rc.1\n", false, 0],
        ["vp v0.3.0 rc.1\n", false, 0],
        ["vp v0.2.2 unexpected\n", false, 0],
        ["v0.2.2\n", false, 0],
        ["vp 0.2.2\n", false, 0],
        ["", false, 0],
        ["vp v1.0.0\n", false, 1],
      ] as const) {
        const fixture = setupFixture(`${major + 1}.0.0`, "unexpected", 0, "runs-node");
        fixture.env.SETUP_TEST_CUSTOM_VERSION = output;
        fixture.env.SETUP_TEST_USE_CUSTOM_VERSION = "1";
        fixture.env.SETUP_TEST_VERSION_EXIT = String(exit);
        try {
          const result = fixture.run();
          assert.equal(result.status, accepted ? 0 : 1, JSON.stringify(output));
          if (!accepted) assert.match(result.stderr, /update vite-plus/i);
        } finally {
          fixture.cleanup();
        }
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refuses Node download when signature verification is bypassed",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      for (const value of ["1", "0"]) {
        const fixture = setupFixture(`${major + 1}.0.0`, "unexpected", 0, "runs-node");
        fixture.env.VP_NODE_SKIP_SIGNATURE_VERIFY = value;
        try {
          const result = fixture.run();
          assert.equal(result.status, 1);
          assert.include(
            NodeFS.readFileSync(NodePath.join(fixture.root, ".goat", "setup-failed"), "utf8"),
            "VP_NODE_SKIP_SIGNATURE_VERIFY",
          );
          assert.isFalse(NodeFS.existsSync(fixture.log));
        } finally {
          fixture.cleanup();
        }
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refuses old vp and explains the update",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(`${major + 1}.0.0`, "unexpected", 0, "runs-node");
      fixture.env.SETUP_TEST_VP_VERSION = "0.2.1";
      try {
        const result = fixture.run();
        assert.equal(result.status, 1);
        assert.match(result.stderr, /update vite-plus/i);
        assert.isFalse(NodeFS.existsSync(fixture.log));
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "opt-out refuses without invoking vp",
    () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(`${major + 1}.0.0`, "unexpected", 0, "runs-node");
      fixture.env.GOAT_SETUP_NO_NODE_DOWNLOAD = "1";
      try {
        const result = fixture.run();
        assert.equal(result.status, 1);
        assert.include(result.stderr, "GOAT_SETUP_NO_NODE_DOWNLOAD");
        assert.isFalse(NodeFS.existsSync(fixture.log));
        assert.isFalse(NodeFS.existsSync(`${fixture.log}.version`));
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("refuses when no installer is present", () => {
    const fixture = setupFixture(process.versions.node, "unexpected");
    NodeFS.unlinkSync(
      NodePath.join(
        fixture.root,
        "bin",
        HostProcess.Platform.defaultValue() === "win32" ? "pnpm.cmd" : "pnpm",
      ),
    );
    try {
      const result = fixture.run();
      assert.equal(result.status, 1);
      assert.include(result.stderr, "pnpm 12.14.0");
      assert.isFalse(NodeFS.existsSync(fixture.log));
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "supported Node runs only vp install",
    () => {
      const fixture = setupFixture(process.versions.node, "unexpected", 0, "runs-node");
      try {
        const result = fixture.run();
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), ["vp i"]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("#2178 fails on an ordinary install error without trying another installer", () => {
    const fixture = setupFixture(process.versions.node, "ERR_PNPM_OUTDATED_LOCKFILE");
    try {
      const result = fixture.run();
      assert.equal(result.status, 1, result.stderr);
      assert.include(
        NodeFS.readFileSync(NodePath.join(fixture.root, ".goat", "setup-failed"), "utf8"),
        "ERR_PNPM_OUTDATED_LOCKFILE",
      );
      assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), ["pnpm"]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("createMarkerDirectory", () => {
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "creates the worktree .goat without group or other access under umask 002 (#1648)",
    () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-setup-"));
      try {
        const markerDir = NodePath.join(root, "worktree", ".goat");
        const setupModule = NodeURL.pathToFileURL(
          NodePath.join(import.meta.dirname, "setup-worktree.ts"),
        );
        // The umask is set in the child, so the result never depends on the host's umask.
        const script = [
          "process.umask(0o002);",
          `const { createMarkerDirectory } = await import(${JSON.stringify(setupModule.href)});`,
          `createMarkerDirectory(${JSON.stringify(markerDir)});`,
        ].join("\n");
        const child = NodeChildProcess.spawnSync(
          process.execPath,
          ["--input-type=module", "--eval", script],
          { encoding: "utf8" },
        );
        assert.equal(child.status, 0, child.stderr);
        for (const directory of [NodePath.dirname(markerDir), markerDir]) {
          assert.equal(NodeFS.statSync(directory).mode & 0o777, 0o700, directory);
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
