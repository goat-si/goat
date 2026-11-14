import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { assert, it } from "@effect/vitest";
import * as SshTunnel from "./tunnel.ts";
import { ARCHIVE } from "./tunnel.fixture.ts";

it("names gzip when a host with tar but no gzip cannot unpack the release archive", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-ssh-runner-"));
  try {
    const bin = NodePath.join(root, "bin");
    const release = NodePath.join(root, "release");
    const archive = `goat-${ARCHIVE.archiveVersion}-linux-x64.tar.gz`;
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(NodePath.join(root, "home"));
    NodeFS.mkdirSync(NodePath.join(release, "goat"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(release, "goat", "goat"), "#!/bin/sh\necho ok\n", {
      mode: 0o755,
    });
    NodeChildProcess.execFileSync("tar", ["-czf", archive, "goat"], { cwd: release });
    NodeChildProcess.execFileSync("sh", ["-c", `sha256sum ${archive} > SHA256SUMS`], {
      cwd: release,
    });
    for (const tool of [
      "sh",
      "mkdir",
      "mktemp",
      "cat",
      "rm",
      "grep",
      "cut",
      "sha256sum",
      "tar",
      "mv",
    ]) {
      NodeFS.symlinkSync(
        NodeChildProcess.execFileSync("sh", ["-c", `command -v ${tool}`], {
          encoding: "utf8",
        }).trim(),
        NodePath.join(bin, tool),
      );
    }
    NodeFS.writeFileSync(
      NodePath.join(bin, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(bin, "curl"),
      `#!/bin/sh\nfor last; do :; done\nfor a; do case "$a" in http*) src="${release}/\${a##*/}" ;; esac; done\nexec cat "$src" > "$last"\n`,
      { mode: 0o755 },
    );
    const runner = NodePath.join(root, "run-goat.sh");
    NodeFS.writeFileSync(runner, SshTunnel.buildRemoteGoatRunnerScript(ARCHIVE));
    const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
      encoding: "utf8",
      env: { HOME: NodePath.join(root, "home"), PATH: bin },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(missing|needs) gzip/);
    assert.notInclude(result.stderr, "Cannot exec");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("reports the archive and source when a remote download fails", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-ssh-runner-"));
  try {
    const bin = NodePath.join(root, "bin");
    const release = NodePath.join(root, "release");
    const archive = `goat-${ARCHIVE.archiveVersion}-linux-x64.tar.gz`;
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(NodePath.join(root, "home"));
    NodeFS.mkdirSync(NodePath.join(release, "goat"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(release, "goat", "goat"), "#!/bin/sh\necho ok\n", {
      mode: 0o755,
    });
    NodeChildProcess.execFileSync("tar", ["-czf", archive, "goat"], { cwd: release });
    NodeChildProcess.execFileSync("sh", ["-c", `sha256sum ${archive} > SHA256SUMS`], {
      cwd: release,
    });
    for (const tool of [
      "sh",
      "mkdir",
      "mktemp",
      "cat",
      "rm",
      "grep",
      "cut",
      "sha256sum",
      "tar",
      "mv",
    ]) {
      NodeFS.symlinkSync(
        NodeChildProcess.execFileSync("sh", ["-c", `command -v ${tool}`], {
          encoding: "utf8",
        }).trim(),
        NodePath.join(bin, tool),
      );
    }
    NodeFS.writeFileSync(
      NodePath.join(bin, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(bin, "curl"), "#!/bin/sh\necho failed >&2\nexit 6\n", {
      mode: 0o755,
    });
    const runner = NodePath.join(root, "run-goat.sh");
    NodeFS.writeFileSync(runner, SshTunnel.buildRemoteGoatRunnerScript(ARCHIVE));
    const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
      encoding: "utf8",
      env: { HOME: NodePath.join(root, "home"), PATH: bin },
    });
    assert.notEqual(result.status, 0);
    assert.include(result.stderr, ARCHIVE.archiveVersion);
    assert.include(result.stderr, "goat-releases/releases/download");
    assert.include(result.stderr, "GOAT_VERSION");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
