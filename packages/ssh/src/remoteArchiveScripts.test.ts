// @effect-diagnostics nodeBuiltinImport:off -- The fixture runs a real shell with an isolated PATH.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { buildRemoteGoatRunnerScript } from "./tunnel.ts";

it("reports missing tar before downloading the remote runtime", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-ssh-tar-"));
  try {
    const bin = NodePath.join(root, "bin");
    const home = NodePath.join(root, "home");
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(home);
    for (const tool of ["sh", "mkdir", "mktemp", "cat", "rm", "mv", "find"]) {
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
      '#!/bin/sh\necho "download attempt" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const runner = NodePath.join(root, "run.sh");
    NodeFS.writeFileSync(runner, buildRemoteGoatRunnerScript({ archiveVersion: "0.1.6" }));
    const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
      encoding: "utf8",
      env: { HOME: home, PATH: bin },
    });
    assert.notEqual(result.status, 0);
    assert.include(result.stderr, "needs tar");
    assert.notInclude(result.stderr, "download attempt");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
