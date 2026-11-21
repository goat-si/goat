// @effect-diagnostics nodeBuiltinImport:off -- Runs the real installer in an isolated home.
import { expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

it.each([true, false])(
  "chooses a launcher compatible with the target runtime (capable: %s)",
  (capable) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-installer-launcher-"));
    try {
      const home = NodePath.join(root, "home '한글");
      const bin = NodePath.join(root, "bin");
      const version = "1.2.3";
      const dir = NodePath.join(home, "runtime/goat/versions", version);
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.mkdirSync(bin);
      const executable = NodePath.join(dir, "goat");
      NodeFS.writeFileSync(
        executable,
        `#!/bin/sh\nif [ "$1" = --version ]; then printf 'goat v1.2.3\\n'; exit 0; fi\n${capable ? 'printf "script-launcher\\n"' : "exit 1"}\n`,
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(NodePath.join(dir, ".install-complete"), `${version}\n`);
      const result = NodeChildProcess.spawnSync(
        "/bin/sh",
        [NodePath.join(import.meta.dirname, "install.sh")],
        {
          env: {
            ...process.env,
            HOME: root,
            GOAT_HOME: home,
            GOAT_INSTALL_BIN_DIR: bin,
            GOAT_VERSION: version,
            TERM: "dumb",
            NO_COLOR: "1",
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const launcher = NodePath.join(bin, "goat");
      expect(NodeFS.lstatSync(launcher).isSymbolicLink()).toBe(!capable);
      if (!capable) expect(NodeFS.readlinkSync(launcher)).toBe(executable);
      expect(
        NodeChildProcess.execFileSync(launcher, ["--version"], { encoding: "utf8" }).trim(),
      ).toBe("goat v1.2.3");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(["file", "link"] as const)("leaves a foreign launcher %s untouched", (kind) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-installer-foreign-"));
  try {
    const home = NodePath.join(root, "home");
    const bin = NodePath.join(root, "bin");
    const dir = NodePath.join(home, "runtime/goat/versions/1.2.3");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(dir, "goat"), "#!/bin/sh\nprintf 'goat v1.2.3\\n'\n", {
      mode: 0o755,
    });
    NodeFS.writeFileSync(NodePath.join(dir, ".install-complete"), "1.2.3\n");
    const launcher = NodePath.join(bin, "goat");
    const foreign = NodePath.join(root, "foreign");
    NodeFS.writeFileSync(foreign, "foreign user content");
    if (kind === "file") NodeFS.writeFileSync(launcher, "foreign user content");
    else NodeFS.symlinkSync(foreign, launcher);
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      [NodePath.join(import.meta.dirname, "install.sh")],
      {
        env: {
          ...process.env,
          HOME: root,
          GOAT_HOME: home,
          GOAT_INSTALL_BIN_DIR: bin,
          GOAT_VERSION: "1.2.3",
          TERM: "dumb",
          NO_COLOR: "1",
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(NodeFS.readFileSync(foreign, "utf8")).toBe("foreign user content");
    if (kind === "file") expect(NodeFS.readFileSync(launcher, "utf8")).toBe("foreign user content");
    else expect(NodeFS.readlinkSync(launcher)).toBe(foreign);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("replaces an owned absolute script with a legacy link when installing an older runtime", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-installer-downgrade-"));
  try {
    const home = NodePath.join(root, "home '한글");
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    for (const [version, capable] of [
      ["1.1.0", true],
      ["1.0.0", false],
    ] as const) {
      const dir = NodePath.join(home, "runtime/goat/versions", version);
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(dir, "goat"),
        `#!/bin/sh\nif [ "$1" = --version ]; then printf 'goat v${version}\\n'; exit 0; fi\n${capable ? 'printf "script-launcher\\n"' : "exit 1"}\n`,
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(NodePath.join(dir, ".install-complete"), `${version}\n`);
      const result = NodeChildProcess.spawnSync(
        "/bin/sh",
        [NodePath.join(import.meta.dirname, "install.sh")],
        {
          env: {
            ...process.env,
            HOME: root,
            GOAT_HOME: home,
            GOAT_INSTALL_BIN_DIR: bin,
            GOAT_VERSION: version,
            TERM: "dumb",
            NO_COLOR: "1",
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
    }
    expect(NodeFS.readlinkSync(NodePath.join(bin, "goat"))).toBe(
      NodePath.join(home, "runtime/goat/versions/1.0.0/goat"),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("leaves a foreign replacement made while the runtime capability is checked", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-installer-race-"));
  try {
    const home = NodePath.join(root, "home");
    const bin = NodePath.join(root, "bin");
    const versions = NodePath.join(home, "runtime/goat/versions");
    const oldDir = NodePath.join(versions, "1.0.0");
    const nextDir = NodePath.join(versions, "1.1.0");
    NodeFS.mkdirSync(oldDir, { recursive: true });
    NodeFS.mkdirSync(nextDir, { recursive: true });
    NodeFS.mkdirSync(bin);
    const old = NodePath.join(oldDir, "goat");
    const target = NodePath.join(nextDir, "goat");
    const launcher = NodePath.join(bin, "goat");
    NodeFS.writeFileSync(old, "old");
    NodeFS.symlinkSync(old, launcher);
    NodeFS.writeFileSync(
      target,
      `#!/bin/sh\nif [ "$1" = --version ]; then printf 'goat v1.1.0\\n'; exit 0; fi\nrm '${launcher}'\nprintf 'foreign replacement' > '${launcher}'\nprintf 'script-launcher\\n'\n`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(nextDir, ".install-complete"), "1.1.0\n");
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      [NodePath.join(import.meta.dirname, "install.sh")],
      {
        env: {
          ...process.env,
          HOME: root,
          GOAT_HOME: home,
          GOAT_INSTALL_BIN_DIR: bin,
          GOAT_VERSION: "1.1.0",
          TERM: "dumb",
          NO_COLOR: "1",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).not.toBe(0);
    expect(NodeFS.readFileSync(launcher, "utf8")).toBe("foreign replacement");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
