// A fake uname/curl on PATH decides what the generated runner would download.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
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
      "#!/bin/sh\necho 'download attempt' >&2\nexit 22\n",
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
      } else {
        assert.notInclude(result.stderr, "download attempt");
        assert.include(result.stderr, "has no GOAT release archive.");
      }
    },
  );
});
