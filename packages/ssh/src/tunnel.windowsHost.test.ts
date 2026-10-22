// Shell doubles run synchronously; the Effect spawner adds nothing to these checks.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  remoteShell,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import {
  buildRemoteHostDownloadScript,
  buildRemoteRuntimeProbeScript,
  REMOTE_HOST_PROCESS_SCRIPT,
  remoteUploadCommand,
  SshEnvironmentManager,
} from "./tunnel.ts";

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
    assert.equal(command.archiveOffset, new TextEncoder().encode(script).byteLength);
    assert.equal(command.archiveLength, archive.byteLength);
    assert.deepEqual(command.stdin.subarray(command.archiveOffset), archive);
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
    assert.equal(posix.archiveOffset, 0);
    assert.equal(posix.archiveLength, archive.byteLength);
  });

  it.effect(
    "installs the win32-x64 zip archive on a Windows Git Bash host with wget and System32 tar.exe",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-install-" });
        const home = `${root}/home`;
        const bin = `${root}/bin`;
        const sys32 = `${root}/System32`;
        const stage = `${root}/stage/goat-${ARCHIVE.archiveVersion}-win32-x64`;
        const release = `${root}/release`;
        for (const dir of [home, bin, sys32, stage, release]) {
          yield* fs.makeDirectory(dir, { recursive: true });
        }
        yield* fs.writeFileString(
          `${stage}/goat`,
          `#!/bin/sh\nif [ "$1" = --version ]; then echo 'goat v${ARCHIVE.archiveVersion}'; else exit 2; fi\n`,
        );
        yield* fs.chmod(`${stage}/goat`, 0o755);
        const zipPath = `${release}/goat-${ARCHIVE.archiveVersion}-win32-x64.zip`;
        NodeChildProcess.execFileSync("tar", [
          "-czf",
          zipPath,
          "-C",
          `${root}/stage`,
          `goat-${ARCHIVE.archiveVersion}-win32-x64`,
        ]);
        const sha = Hex.encode(yield* crypto.digest("SHA-256", yield* fs.readFile(zipPath)));
        yield* fs.writeFileString(
          `${release}/SHA256SUMS`,
          `${sha} *goat-${ARCHIVE.archiveVersion}-win32-x64.zip\n`,
        );
        yield* fs.writeFileString(
          `${bin}/uname`,
          `#!/bin/sh\nif [ "$1" = -s ]; then echo MINGW64_NT-10.0-26200; else echo x86_64; fi\n`,
        );
        yield* fs.writeFileString(
          `${bin}/cygpath`,
          `#!/bin/sh\nif [ "$1" = -S ]; then echo '${sys32}'; else printf '%s\\n' "$2"; fi\n`,
        );
        yield* fs.writeFileString(
          `${sys32}/tar.exe`,
          `#!/bin/sh\nexec tar -xzf "$2" -C "$4" "$5"\n`,
        );
        yield* fs.writeFileString(
          `${bin}/wget`,
          `#!/bin/sh\nif [ "$1" = --help ]; then echo --retry-on-http-error; exit 0; fi\nurl=""; out=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in -O) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac\ndone\ncp "${release}/$(basename "$url")" "$out"\n`,
        );
        for (const file of [`${bin}/uname`, `${bin}/cygpath`, `${sys32}/tar.exe`, `${bin}/wget`]) {
          yield* fs.chmod(file, 0o755);
        }
        for (const dir of (process.env.PATH ?? "").split(":")) {
          if (!dir) continue;
          const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
          for (const entry of entries) {
            if (entry === "curl" || entry === "wget" || entry === "uname" || entry === "cygpath")
              continue;
            yield* fs.symlink(`${dir}/${entry}`, `${bin}/${entry}`).pipe(Effect.ignore);
          }
        }
        const result = NodeChildProcess.spawnSync(remoteShell, ["-s"], {
          input: buildRemoteHostDownloadScript(ARCHIVE),
          encoding: "utf8",
          env: { ...process.env, HOME: home, PATH: bin },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `goat v${ARCHIVE.archiveVersion}\n`);
        const record = yield* fs.readFileString(
          `${home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-record`,
        );
        assert.include(record.trim(), `${ARCHIVE.archiveVersion} ${sha} `);
        assert.isTrue(record.trim().endsWith(" https"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "rejects a 32-bit Git Bash host in the probe with an unsupported_platform diagnostic",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-probe-" });
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-home-" });
        yield* fs.writeFileString(
          `${bin}/uname`,
          `#!/bin/sh\nif [ "$1" = -s ]; then echo MINGW32_NT-10.0-26200; else echo i686; fi\n`,
        );
        yield* fs.chmod(`${bin}/uname`, 0o755);
        const probe = NodeChildProcess.spawnSync(remoteShell, ["-s"], {
          input: buildRemoteRuntimeProbeScript(ARCHIVE.archiveVersion, "runtime"),
          encoding: "utf8",
          env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        assert.notEqual(probe.status, 0);
        assert.include(probe.stderr, "Remote host i686 has no GOAT release archive.");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each([
    {
      name: "cmd.exe default OpenSSH shell",
      stderr:
        "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
      reason: "missing_tools",
      instruction:
        "Install Git for Windows on devbox and set Git Bash as the OpenSSH DefaultShell, then try again.",
    },
    {
      name: "PowerShell default OpenSSH shell",
      stderr:
        "sh : The term 'sh' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\nAt line:1 char:1\r\n+ sh -l -s\r\n+ FullyQualifiedErrorId : CommandNotFoundException\r\n",
      reason: "missing_tools",
      instruction:
        "Install Git for Windows on devbox and set Git Bash as the OpenSSH DefaultShell, then try again.",
    },
    {
      name: "Git Bash host missing System32 tar.exe",
      stderr: "sh: line 118: /c/Windows/System32/tar.exe: No such file or directory\n",
      reason: "missing_tools",
      instruction: "Install tar on devbox, then try again.",
    },
    {
      name: "Git Bash host missing tar.exe on PATH",
      stderr: "bash: tar.exe: command not found\n",
      reason: "missing_tools",
      instruction: "Install tar on devbox, then try again.",
    },
    {
      name: "32-bit Git Bash host without a release archive",
      stderr: "Remote host i686 has no GOAT release archive.\n",
      reason: "unsupported_platform",
      instruction: "Use Linux, an Apple Silicon Mac, or Windows.",
    },
  ] as const)("surfaces a clear, actionable error for $name", ({ stderr, reason, instruction }) => {
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.succeed(
        command._tag === "StandardCommand" && command.args.includes("-G")
          ? makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n")
          : ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.empty,
              stderr: Stream.make(new TextEncoder().encode(stderr)),
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
      ),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed(ARCHIVE),
        leaveRemoteServerRunning: true,
      }),
    );
    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      assert.equal(result.status?.state, "failed");
      assert.equal(result.status?.failure?.reason, reason);
      assert.equal(result.status?.failure?.fix.actor, "human");
      assert.equal(result.status?.failure?.fix.instruction, instruction);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("does not misclassify a missing archive file opened by tar as missing_tools", () => {
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.succeed(
        command._tag === "StandardCommand" && command.args.includes("-G")
          ? makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n")
          : ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.empty,
              stderr: Stream.make(
                new TextEncoder().encode(
                  "tar: /tmp/missing.tar.gz: Cannot open: No such file or directory\n",
                ),
              ),
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(2)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
      ),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed(ARCHIVE),
        leaveRemoteServerRunning: true,
      }),
    );
    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.equal(result.code, "operation_failed");
        assert.notInclude(result.fix?.instruction ?? "", "Install tar");
      }
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
