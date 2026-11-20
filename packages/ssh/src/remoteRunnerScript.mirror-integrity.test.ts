import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { buildRemoteGoatRunnerScript } from "./tunnel.ts";

it("rejects a tampered archive from a release mirror without replacing the installed runtime", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-mirror-integrity-"));
  try {
    const home = NodePath.join(root, "home");
    const bin = NodePath.join(root, "bin");
    const runtime = NodePath.join(home, ".goat/runtime/goat/versions/1.2.3");
    NodeFS.mkdirSync(runtime, { recursive: true });
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(runtime, "goat"), "old runtime", { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(runtime, ".install-complete"), "old\n");
    const expected = NodeCrypto.createHash("sha256").update("original archive").digest("hex");
    NodeFS.writeFileSync(
      NodePath.join(bin, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n',
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(bin, "curl"),
      `#!/bin/sh\nout=; url=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done\nprintf '%s\\n' "$url" >> "$HOME/requests"\ncase "$url" in */SHA256SUMS) printf '%s  %s\\n' '${expected}' 'goat-1.2.3-darwin-arm64.tar.gz' > "$out";; *) printf 'tampered archive' > "$out";; esac\n`,
      { mode: 0o755 },
    );
    const runner = buildRemoteGoatRunnerScript({
      archiveVersion: "1.2.3",
      releaseBaseUrl: "https://mirror.example/releases",
    });
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", runner, "runner", "--version"], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    assert.notEqual(result.status, 0);
    assert.include(result.stderr, "Checksum mismatch");
    assert.equal(NodeFS.readFileSync(NodePath.join(runtime, "goat"), "utf8"), "old runtime");
    assert.equal(NodeFS.readFileSync(NodePath.join(runtime, ".install-complete"), "utf8"), "old\n");
    assert.include(
      NodeFS.readFileSync(NodePath.join(home, "requests"), "utf8"),
      "https://mirror.example/releases/",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
