// Shell doubles run synchronously; the Effect spawner adds nothing to these checks.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { remoteShell } from "./tunnel.fixture.ts";
import { REMOTE_HOST_PROCESS_SCRIPT, remoteUploadCommand } from "./tunnel.ts";

// Stand-ins for the Git Bash host: uname reports MINGW, PowerShell answers for two
// processes in its CRLF output, cygpath maps C:\ paths, and tasklist knows one PID.
const WINDOWS_DOUBLES = {
  uname: "echo MINGW64_NT-10.0-26200",
  "powershell.exe": String.raw`case "$GOAT_PROCESS_ID" in
  4242) owner=self ;;
  5151) owner=other ;;
  *) exit 1 ;;
esac
printf '%s\r\n' "$owner" 2026-10-13T14:23:57.9648900Z 'C:\Users\Jo Doe\.goat\runtime\goat\versions\1.2.3\goat.exe' serve --host 127.0.0.1 --port 3773 --base-dir 'C:\Users\Jo Doe\.goat'`,
  cygpath: String.raw`[ "$1" = -u ] && printf '%s\n' "$2" | sed -e 's|^C:|/c|' -e 's|\\|/|g'`,
  "tasklist.exe": `[ "$2" = "PID eq 4242" ] && echo '"goat.exe","4242","Services","0","1 K"'`,
};

const runWithDoubles = (bin: string, body: string) =>
  NodeChildProcess.spawnSync(remoteShell, ["-c", `${REMOTE_HOST_PROCESS_SCRIPT}\n${body}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });

describe("Windows SSH host", () => {
  it.effect("maps a native server's command line to the POSIX launch identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-host-" });
      for (const [name, body] of Object.entries(WINDOWS_DOUBLES)) {
        yield* fs.writeFileString(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
        yield* fs.chmod(`${bin}/${name}`, 0o755);
      }
      const uid = NodeChildProcess.execFileSync("id", ["-u"], { encoding: "utf8" }).trim();

      const owned = runWithDoubles(
        bin,
        "server_command 4242 && server_uid 4242 && server_start 4242",
      );
      assert.equal(owned.status, 0, owned.stderr);
      assert.deepEqual(owned.stdout.split("\n"), [
        "/c/Users/Jo Doe/.goat/runtime/goat/versions/1.2.3/goat serve --host 127.0.0.1 --port 3773 --base-dir /c/Users/Jo Doe/.goat",
        uid,
        "2026-10-13T14:23:57.9648900Z",
        "",
      ]);
      // Another account's process never matches this user's id.
      assert.equal(runWithDoubles(bin, "server_uid 5151").stdout, "other\n");
      // A process PowerShell cannot find has no identity to verify.
      assert.notEqual(runWithDoubles(bin, "server_command 9999").status, 0);
      assert.equal(runWithDoubles(bin, "server_alive 4242").status, 0);
      assert.notEqual(runWithDoubles(bin, "server_alive 9999").status, 0);
      assert.equal(runWithDoubles(bin, 'printf %s "$MSYS"').stdout, "winsymlinks:sys");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("feeds a Windows host the upload script ahead of the archive on stdin", () => {
    const archive = new Uint8Array(256 * 1024).map((_, index) => index % 251);
    const script = `set -eu\ncat > "$GOAT_UPLOAD_OUT"\nprintf 'ran %s\\n' "$#"\n`;
    const command = remoteUploadCommand(script, archive, "win32");
    // The remote command stays far below Windows OpenSSH's ~8 KiB limit.
    assert.isBelow(command.remoteCommandArgs.join(" ").length, 512);
    const out = NodeChildProcess.execFileSync("mktemp", [], { encoding: "utf8" }).trim();
    const result = NodeChildProcess.spawnSync(
      remoteShell,
      ["-c", command.remoteCommandArgs.join(" ")],
      {
        input: command.stdin,
        env: { ...process.env, GOAT_UPLOAD_OUT: out },
      },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), "ran 0\n");
    assert.deepEqual(new Uint8Array(NodeChildProcess.execFileSync("cat", [out])), archive);
    NodeChildProcess.execFileSync("rm", ["-f", out]);

    const posix = remoteUploadCommand(script, archive, "linux");
    assert.strictEqual(posix.stdin, archive);
  });
});
