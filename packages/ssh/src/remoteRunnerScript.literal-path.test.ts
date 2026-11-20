// @effect-diagnostics nodeBuiltinImport:off -- The fixture runs real shell scripts against isolated files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { assert, it } from "@effect/vitest";
import { REMOTE_RUNNER_SCRIPT } from "./remoteRunnerScript.ts";
import { buildRemoteGoatRunnerScript } from "./tunnel.ts";
import { runtimeArchiveUploadScript } from "./runtimeOfficeFonts.ts";

it.each(["sha256sum", "shasum"])(
  "hashes archive and executable under a newline home with %s",
  (tool) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-hash-"));
    try {
      const bin = NodePath.join(root, "bin");
      const staging = NodePath.join(root, "home\nquoted", "stage");
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(staging, { recursive: true });
      NodeFS.symlinkSync(
        tool === "sha256sum" && NodeFS.existsSync("/sbin/sha256sum")
          ? "/sbin/sha256sum"
          : `/usr/bin/${tool}`,
        NodePath.join(bin, tool),
      );
      NodeFS.symlinkSync("/usr/bin/cut", NodePath.join(bin, "cut"));
      NodeFS.writeFileSync(NodePath.join(staging, "archive"), "archive content");
      NodeFS.writeFileSync(NodePath.join(staging, "goat"), "executable content");
      const archiveStart = REMOTE_RUNNER_SCRIPT.indexOf("  if command -v sha256sum");
      const archiveEnd = REMOTE_RUNNER_SCRIPT.indexOf('  if [ -z "$GOAT_EXPECTED"', archiveStart);
      const executableStart = REMOTE_RUNNER_SCRIPT.indexOf("  if command -v shasum", archiveEnd);
      const executableEnd = REMOTE_RUNNER_SCRIPT.indexOf("  # Publish provenance", executableStart);
      assert.isTrue(
        archiveStart >= 0 && archiveEnd > archiveStart && executableEnd > executableStart,
      );
      const script = `${REMOTE_RUNNER_SCRIPT.slice(archiveStart, archiveEnd)}\n${REMOTE_RUNNER_SCRIPT.slice(executableStart, executableEnd)}\nprintf '%s\\n%s\\n' "$GOAT_ACTUAL" "$GOAT_EXECUTABLE_SHA256"`;
      const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        env: { PATH: bin, GOAT_STAGING: staging, GOAT_ARCHIVE: "archive" },
      });
      assert.equal(result.status, 0, result.stderr);
      const digest = (content: string) =>
        NodeCrypto.createHash("sha256").update(content).digest("hex");
      assert.deepEqual(result.stdout.trim().split("\n"), [
        digest("archive content"),
        digest("executable content"),
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(["", "g".repeat(64), "a".repeat(63), "A".repeat(64), "a".repeat(64)])(
  "validates executable digest before publishing: %s",
  (executableDigest) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-digest-"));
    try {
      const home = NodePath.join(root, "home");
      const bin = NodePath.join(root, "bin");
      const stage = NodePath.join(root, "stage", "goat-1.2.3-darwin-arm64");
      NodeFS.mkdirSync(home);
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(stage, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(stage, "goat"), "#!/bin/sh\nprintf 'goat v1.2.3\\n'\n", {
        mode: 0o755,
      });
      const archive = NodePath.join(root, "archive.tar.gz");
      const tar = NodeChildProcess.spawnSync(
        "/usr/bin/tar",
        ["-czf", archive, "-C", NodePath.dirname(stage), NodePath.basename(stage)],
        { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      );
      assert.equal(tar.status, 0, tar.stderr);
      const hash = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(archive))
        .digest("hex");
      NodeFS.writeFileSync(
        NodePath.join(bin, "sha256sum"),
        `#!/bin/sh\nprintf '%s  -\\n' '${hash}'\n`,
        {
          mode: 0o755,
        },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "shasum"),
        `#!/bin/sh\nprintf '%s\\n' '${executableDigest}'\n`,
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        `#!/bin/sh\nout=; url=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done\ncase "$url" in */SHA256SUMS) printf '%s  %s\\n' '${hash}' 'goat-1.2.3-darwin-arm64.tar.gz' > "$out";; *) cp "$ARCHIVE_FIXTURE" "$out";; esac\n`,
        { mode: 0o755 },
      );
      const runner = buildRemoteGoatRunnerScript({
        archiveVersion: "1.2.3",
        releaseBaseUrl: "https://example.invalid",
      });
      const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", runner, "runner", "--version"], {
        encoding: "utf8",
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, ARCHIVE_FIXTURE: archive },
      });
      const installed = NodePath.join(home, ".goat/runtime/goat/versions/1.2.3");
      if (executableDigest === "a".repeat(64)) {
        assert.equal(result.status, 0, result.stderr);
        assert.isTrue(NodeFS.existsSync(NodePath.join(installed, ".install-record")));
      } else {
        assert.notEqual(result.status, 0);
        assert.include(result.stderr, "Could not verify the GOAT executable checksum.");
        assert.isFalse(NodeFS.existsSync(installed));
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("extracts verified optional fonts from a newline upload path", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-font-"));
  try {
    const stage = NodePath.join(root, "stage");
    const assets = NodePath.join(stage, "client/assets");
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "font\narchive.tar.gz");
    NodeFS.mkdirSync(assets, { recursive: true });
    NodeFS.mkdirSync(source);
    NodeFS.writeFileSync(NodePath.join(source, "font.woff2"), "font fixture");
    const tar = NodeChildProcess.spawnSync(
      "/usr/bin/tar",
      ["-czf", archive, "-C", source, "font.woff2"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
    );
    assert.equal(tar.status, 0, tar.stderr);
    const bytes = NodeFS.readFileSync(archive);
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const anchor = '  rm -f "$GOAT_STAGING/$GOAT_ARCHIVE" "$GOAT_STAGING/SHA256SUMS"';
    const script = runtimeArchiveUploadScript(anchor, undefined, {
      archiveBytes: bytes.length,
      sha256: hash,
    });
    const start = script.indexOf('  if [ -n "${GOAT_SSH_UPLOADED_FONTS:-}" ]');
    const end = script.indexOf(anchor, start);
    assert.isTrue(start >= 0 && end > start);
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", script.slice(start, end).replaceAll("'\\''", "'")],
      {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          GOAT_STAGING: stage,
          GOAT_SSH_UPLOADED_FONTS: archive,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.isTrue(NodeFS.existsSync(NodePath.join(assets, "font.woff2")), result.stderr);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
