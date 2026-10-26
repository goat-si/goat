import { assert } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Tracer from "effect/Tracer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import * as SshTunnel from "./tunnel.ts";

// Select the shell for every real remote-script fixture, including direct runner-file execution.
// Generated scripts invoke nested runners themselves; changing those invocations would alter
// the production script under test. Runner bytes also stay intact for retained-hash checks.
export const remoteShell = process.env.T3_SSH_TEST_SHELL ?? "sh";
export const remoteShellCommand = `'${remoteShell.replaceAll("'", "'\\''")}'`;

export const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

export const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

export const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

export const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

export const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

export const hangingHttpClient = HttpClient.make(() => Effect.never);

export const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

export function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

/** Every ssh command ends its options with `--`; only the remote launch passes args after `sh -s --`. */
export const isRemoteLaunch = (args: ReadonlyArray<string>): boolean =>
  args.some((arg, index) => arg === "-s" && args[index + 1] === "--");

export const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
// Protocol-only cases explicitly select the mirror compatibility path.
export const PROTOCOL_ARCHIVE = { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror" };
export const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

export const uploadTarget = {
  alias: "devbox",
  hostname: "devbox.example.com",
  username: "julius",
  port: 2222,
} as const;
export const platform = HostProcess.Platform.defaultValue() === "darwin" ? "darwin" : "linux";
export const arch = HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x64";
export const encoder = new TextEncoder();

export const makeUploadFixture = Effect.fn("test.makeUploadFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preparation-" });
  const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
  const stage = `${root}/stage/${stem}`;
  const directory = `${root}/mirror/v${ARCHIVE.archiveVersion}`;
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    `${stage}/goat`,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo goat v${ARCHIVE.archiveVersion}; else exit 2; fi\n`,
  );
  yield* fs.chmod(`${stage}/goat`, 0o700);
  const child = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", `${directory}/${stem}.tar.gz`, "-C", `${root}/stage`, stem]),
  );
  assert.equal(yield* child.exitCode, 0);
  const bytes = yield* fs.readFile(`${directory}/${stem}.tar.gz`);
  const crypto = yield* Crypto.Crypto;
  const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
  yield* fs.writeFileString(`${directory}/SHA256SUMS`, `${sha256}  ${stem}.tar.gz\n`);
  return { root, directory, bytes, sha256, spawner, fs };
});

export const recordSpans = (spans: Tracer.Span[]) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });

// These transport-only tests model an installed exact requested archive.
export const makeProtocolTestSpawner = (spawn: Parameters<typeof ChildProcessSpawner.make>[0]) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
      if (
        stdin !== undefined &&
        typeof stdin === "object" &&
        "stream" in stdin &&
        Stream.isStream(stdin.stream)
      ) {
        const bytes = yield* stdin.stream.pipe(Stream.runCollect);
        const script = new TextDecoder().decode(
          new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
        );
        if (script.includes("ready=false") && !isRemoteLaunch(commandArgs(command)))
          return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: true }));
        if (command._tag === "StandardCommand")
          return yield* spawn({
            ...command,
            options: {
              ...command.options,
              stdin: { ...stdin, stream: Stream.fromIterable(bytes) },
            },
          });
      }
      return yield* spawn(command);
    }),
  );

type NativeScripts = {
  runner: string;
  launch: string;
  pairing: string;
  mcp: string;
  upload: string | null;
  probe: string;
};

// One native Node process renders every request; Vite reformats Function.toString().
export const nativeScriptsBatch = Effect.fn("test.nativeScriptsBatch")(function* (
  requests: ReadonlyArray<{
    input: SshTunnel.RemoteGoatRunnerOptions;
    selection?: SshTunnel.PreparedRemoteRuntime | undefined;
  }>,
  moduleUrl = new URL("./tunnel.ts", import.meta.url).href,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const script = `import * as t from ${JSON.stringify(moduleUrl)};
const requests = ${JSON.stringify(requests)};
console.log(JSON.stringify(requests.map(({ input, selection }) => ({ runner: t.buildRemoteGoatRunnerScript(input), launch: t.buildRemoteLaunchScript(input, selection), pairing: t.buildRemotePairingScript(${JSON.stringify(REMOTE_RUNTIME_STATE_KEY)}, input, selection), mcp: t.buildRemoteMcpSessionScript(${JSON.stringify(REMOTE_RUNTIME_STATE_KEY)}, { label: "fixture", ttl: "1h", runtimeModeCeiling: null }, input, selection), probe: t.buildRemoteRuntimeProbeScript(input.archiveVersion ?? "", ${JSON.stringify(REMOTE_RUNTIME_STATE_KEY)}, true), upload: input.nodeScriptPath ? null : t.buildRemoteGoatUploadInstallerScript(input, "A".repeat(64)) }))));`;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["--input-type=module", "-e", script]),
  );
  const result = yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      code: child.exitCode,
    },
    { concurrency: "unbounded" },
  );
  assert.equal(result.code, 0, result.stderr);
  const all = JSON.parse(result.stdout) as Array<NativeScripts>;
  assert.equal(all.length, requests.length);
  for (const scripts of all)
    for (const entry of ["launch", "pairing", "mcp", "probe"] as const)
      assert.notMatch(scripts[entry], /@@(?:GOAT|T3)_[A-Z_]+@@/);
  return all;
});

export const nativeScripts = (
  input: SshTunnel.RemoteGoatRunnerOptions,
  selection?: SshTunnel.PreparedRemoteRuntime,
  moduleUrl?: string,
) => nativeScriptsBatch([{ input, selection }], moduleUrl).pipe(Effect.map((all) => all[0]!));

// Archive doubles are Node scripts; emulate archive ps output only for the captured seed child.
export const installArchivePsDouble = Effect.fn("test.installArchivePsDouble")(function* (
  home: string,
  pid: number,
  port: number,
  version: string,
  /** A command that is not GOAT's managed invocation, for a server GOAT must not adopt. */
  foreignCommand?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bin = `${home}/.test/identity-bin`;
  yield* fs.makeDirectory(bin, { recursive: true });
  const command =
    foreignCommand ??
    `$HOME/.goat/runtime/goat/versions/${version}/goat serve --host 127.0.0.1 --port ${port} --base-dir $HOME/.goat`;
  yield* fs.writeFileString(
    `${bin}/ps`,
    `#!/bin/sh
if [ "$1 $2 $3 $4" = '-o uid= -p ${pid}' ] && [ -f "$HOME/.test/foreign-uid" ]; then
  # A test hands the server to another user by naming that user's uid here.
  exec cat "$HOME/.test/foreign-uid"
elif [ "$1 $2 $3 $4" = '-o command= -p ${pid}' ]; then
  # A test hands the server to a foreign owner by naming another command here.
  if [ -f "$HOME/.test/foreign-command" ]; then exec cat "$HOME/.test/foreign-command"; fi
  printf '%s\\n' "${command}"
else
  exec /bin/ps "$@"
fi
`,
  );
  yield* fs.chmod(`${bin}/ps`, 0o700);
});
