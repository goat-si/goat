// A fake uname/curl on PATH decides what the generated runner would download.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { buildRemoteGoatRunnerScript } from "./tunnel.ts";

const ARCHIVE = {
  archiveVersion: "1.2.3-preview.20260911.4",
  releaseBaseUrl: "https://example.invalid/releases",
} as const;

const runRunner = (host: { readonly system: string; readonly machine: string }) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-ssh-runner-"));
  try {
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(NodePath.join(root, "home"));
    NodeFS.writeFileSync(
      NodePath.join(bin, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${host.system} ;; -m) echo ${host.machine} ;; esac\n`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(bin, "curl"),
      "#!/bin/sh\necho 'download attempt' >&2\necho 'curl: (6) Could not resolve host: example.invalid' >&2\nexit 6\n",
      { mode: 0o755 },
    );
    const runner = NodePath.join(root, "run-goat.sh");
    NodeFS.writeFileSync(runner, buildRemoteGoatRunnerScript(ARCHIVE));
    const result = NodeChildProcess.spawnSync("sh", [runner, "--version"], {
      encoding: "utf8",
      env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return result;
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

describe("remote runner platform gate", () => {
  it.each([
    { host: "Darwin x86_64", system: "Darwin", machine: "x86_64", downloads: false },
    { host: "Darwin arm64", system: "Darwin", machine: "arm64", downloads: true },
  ])(
    "only downloads a release archive the host can run: $host",
    ({ system, machine, downloads }) => {
      const result = runRunner({ system, machine });
      assert.notEqual(result.status, 0);
      if (downloads) {
        assert.include(result.stderr, "download attempt");
        // A bare curl error does not tell the user that GOAT itself could not be downloaded.
        assert.include(result.stderr, ARCHIVE.archiveVersion);
        assert.include(result.stderr, ARCHIVE.releaseBaseUrl);
        assert.include(
          result.stderr,
          "https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh",
        );
      } else {
        assert.notInclude(result.stderr, "download attempt");
        assert.include(result.stderr, "has no GOAT release archive.");
      }
    },
  );
});

// A PATH without gzip; tar fails the way GNU tar does when it cannot exec gzip.
const runUnpack = (input: {
  readonly system: string;
  readonly machine: string;
  readonly gzip: boolean;
}) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-ssh-unpack-"));
  try {
    const bin = NodePath.join(root, "bin");
    const release = NodePath.join(root, "release");
    const windows = input.system.startsWith("MINGW");
    const archive = `goat-${ARCHIVE.archiveVersion}-${windows ? "win32-x64.zip" : "linux-x64.tar.gz"}`;
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(release);
    NodeFS.mkdirSync(NodePath.join(root, "home"));
    NodeFS.writeFileSync(NodePath.join(release, archive), "archive bytes");
    const digest = NodeCrypto.createHash("sha256").update("archive bytes").digest("hex");
    NodeFS.writeFileSync(NodePath.join(release, "SHA256SUMS"), `${digest}  ${archive}\n`);
    for (const tool of [
      "sh",
      "mkdir",
      "mktemp",
      "cat",
      "rm",
      "grep",
      "cut",
      "mv",
      "sha256sum",
      "shasum",
      "perl",
      "find",
      "rmdir",
      "sleep",
      "ln",
      "readlink",
      "chmod",
      "dirname",
      "basename",
      "head",
      "tr",
      "sed",
      "cp",
      "touch",
      "ls",
      "id",
      "kill",
      "env",
    ]) {
      const found = NodeChildProcess.spawnSync("sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (found.startsWith("/")) NodeFS.symlinkSync(found, NodePath.join(bin, tool));
    }
    const script = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    script("uname", `case "$1" in -s) echo ${input.system} ;; -m) echo ${input.machine} ;; esac`);
    script(
      "curl",
      `for last; do :; done\nfor a; do case "$a" in http*) src="${release}/\${a##*/}" ;; esac; done\nexec cat "$src" > "$last"`,
    );
    const tarFailure =
      "echo 'tar (child): gzip: Cannot exec: No such file or directory' >&2\nexit 2";
    script(windows ? "tar.exe" : "tar", tarFailure);
    script("cygpath", `echo ${bin}`);
    if (input.gzip) script("gzip", "exit 0");
    const runner = NodePath.join(root, "run-goat.sh");
    NodeFS.writeFileSync(runner, buildRemoteGoatRunnerScript(ARCHIVE));
    return NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
      encoding: "utf8",
      env: { HOME: NodePath.join(root, "home"), PATH: bin },
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

describe("remote runner archive unpacking", () => {
  it("names gzip when a host with tar but no gzip cannot unpack the release archive", () => {
    const result = runUnpack({ system: "Linux", machine: "x86_64", gzip: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(missing|needs) gzip/);
    assert.notInclude(result.stderr, "Cannot exec");
  });

  it("shows tar's own error when gzip is present", () => {
    const result = runUnpack({ system: "Linux", machine: "x86_64", gzip: true });
    assert.notEqual(result.status, 0);
    assert.include(result.stderr, "Cannot exec");
    assert.notMatch(result.stderr, /(missing|needs) gzip/);
  });

  it("does not blame gzip for a Windows zip archive", () => {
    const result = runUnpack({ system: "MINGW64_NT-10.0", machine: "x86_64", gzip: false });
    assert.notEqual(result.status, 0);
    assert.include(result.stderr, "Cannot exec");
    assert.notMatch(result.stderr, /(missing|needs) gzip/);
  });
});
