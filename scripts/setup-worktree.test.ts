// @effect-diagnostics nodeBuiltinImport:off - runs setup's directory step in a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";

import {
  isCorepackLauncherMissing,
  pinnedNodeRunners,
  worktreeInstallCandidates,
} from "./setup-worktree.ts";

describe("worktreeInstallCandidates", () => {
  it("prefers vp, then pnpm, then npx vite-plus, without the --yes pnpm 12 can reject (#1001)", () => {
    const vp = { command: "vp i --frozen-lockfile", tool: "vp" };
    const pnpm = { command: "pnpm install --frozen-lockfile", tool: "pnpm" };
    const npx = { command: "npx --yes vite-plus i --frozen-lockfile", tool: "npx vite-plus" };
    assert.deepEqual(worktreeInstallCandidates({ vp: true, pnpm: true }), [vp, pnpm, npx]);
    assert.deepEqual(worktreeInstallCandidates({ vp: false, pnpm: true }), [pnpm, npx]);
    assert.deepEqual(worktreeInstallCandidates({ vp: false, pnpm: false }), [npx]);
  });
});

it("reruns setup under the pinned Node with the global vp, else with Node from npm", () => {
  const vp = {
    command: "vp env exec --node 26.12.1 -- node scripts/setup-worktree.ts",
    tool: "vp",
  };
  const npx = {
    command: "npx --yes --package=node@26.12.1 -- node scripts/setup-worktree.ts",
    tool: "npx node@26.12.1",
  };
  assert.deepEqual(pinnedNodeRunners({ pinned: "26.12.1", vp: true, npx: true }), [vp, npx]);
  assert.deepEqual(pinnedNodeRunners({ pinned: "26.12.1", vp: false, npx: true }), [npx]);
  assert.deepEqual(pinnedNodeRunners({ pinned: "26.12.1", vp: false, npx: false }), []);
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
  npx: "installer" | "runs-node" | "hangs" = "installer",
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
    JSON.stringify({ type: "module", engines: { node: pinned } }),
  );
  const windows = HostProcess.Platform.defaultValue() === "win32";
  // Stands in for `npx --package=node@<pin> -- node <script>`: the pin becomes this Node.
  const nodeRunner = `if [ "$3" = "--" ] && [ "$4" = "node" ]; then printf '%s' "$SETUP_TEST_PIN" > package.json; exec "$SETUP_TEST_NODE" "$5"; fi\n`;
  // A runner whose own child outlives it unless the whole group is signalled.
  const hangingRunner = `( trap 'printf "%s\\n" grandchild-signalled >> "$SETUP_TEST_LOG"; exit 0' TERM; while :; do sleep 1; done ) &\nprintf 'ready %s\\n' "$!"\nwait\n`;
  const npxBody = npx === "runs-node" ? nodeRunner : npx === "hangs" ? hangingRunner : "";
  for (const name of ["pnpm", "npx"] as const) {
    const noise = "x".repeat(60);
    const contents = windows
      ? `@echo off\r\necho ${name}>>"%SETUP_TEST_LOG%"\r\n${name === "pnpm" ? `echo ${pnpmOutput} 1>&2\r\nfor /L %%i in (1,1,${trailingLines}) do echo ${noise} 1>&2\r\nexit /b 1` : "exit /b 0"}\r\n`
      : `#!/bin/sh\nprintf '%s\n' '${name}' >> "$SETUP_TEST_LOG"\n${name === "pnpm" ? `printf '%s\n' "${pnpmOutput}" >&2\ni=0\nwhile [ "$i" -lt ${trailingLines} ]; do printf '%s\n' '${noise}' >&2; i=$((i + 1)); done\nexit 1` : `${npxBody}exit 0`}\n`;
    NodeFS.writeFileSync(NodePath.join(bin, `${name}${windows ? ".cmd" : ""}`), contents, {
      mode: 0o755,
    });
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const path = windows
    ? [bin, NodePath.join(systemRoot, "System32"), systemRoot]
    : [bin, "/usr/bin", "/bin"];
  const env = {
    ...process.env,
    PATH: path.join(NodePath.delimiter),
    GOAT_PROJECT_ROOT: root,
    SETUP_TEST_LOG: log,
    SETUP_TEST_NODE: process.execPath,
    SETUP_TEST_PIN: JSON.stringify({ type: "module", engines: { node: process.versions.node } }),
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
      assert.include(
        failed,
        `could not start itself under Node.js ${major + 1}.0.0. Tried:\nnpx node@${major + 1}.0.0: no output`,
      );
      // npx was asked for the pinned Node and did not start setup; pnpm, the installer, never ran.
      assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), ["npx"]);
      assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-running")));
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "sets up under the pinned Node when PATH's Node is another release and vp is absent",
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
        // npx supplies Node, then the rerun installs: pnpm's launcher is missing, so npx installs.
        assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
          "npx",
          "pnpm",
          "npx",
        ]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a cancel reaches everything the pinned-Node rerun started, and leaves only setup-failed",
    async () => {
      const [major = 0] = process.versions.node.split(".").map(Number);
      const fixture = setupFixture(`${major + 1}.0.0`, "unexpected install", 0, "hangs");
      let grandchild: number | undefined;
      try {
        const setup = NodeChildProcess.spawn(process.execPath, [fixture.script], {
          cwd: fixture.root,
          env: fixture.env,
          stdio: ["ignore", "pipe", "ignore"],
        });
        setup.stdout.setEncoding("utf8");
        const exited = new Promise<number | null>((resolve) => setup.on("exit", resolve));
        let seen = "";
        await new Promise<void>((resolve) => {
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
          "npx",
          "grandchild-signalled",
        ]);
      } finally {
        if (grandchild !== undefined) {
          try {
            process.kill(grandchild, "SIGKILL");
          } catch {
            // Already gone, which is what the test expects.
          }
        }
        fixture.cleanup();
      }
    },
  );

  it("#2178 steps past corepack's missing pnpm launcher to the next installer", () => {
    const fixture = setupFixture(
      process.versions.node,
      "Error: Cannot find module '/x/.cache/node/corepack/v1/pnpm/12.14.0/bin/pnpm.cjs'",
    );
    try {
      const result = fixture.run();
      assert.equal(result.status, 0, result.stderr);
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, ".goat", "setup-done")));
      assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
        "pnpm",
        "npx",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("#2178 still steps past the missing launcher when more output follows it than the marker keeps", () => {
    const fixture = setupFixture(
      process.versions.node,
      "Error: Cannot find module '/x/.cache/node/corepack/v1/pnpm/12.14.0/bin/pnpm.cjs'",
      200,
    );
    try {
      const result = fixture.run();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(NodeFS.readFileSync(fixture.log, "utf8").trim().split(/\r?\n/), [
        "pnpm",
        "npx",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

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
