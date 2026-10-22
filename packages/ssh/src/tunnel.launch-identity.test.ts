// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HostProcess from "@goat/shared/HostProcess";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { ARCHIVE, remoteShell } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { buildRemoteNodeEnvScript, REMOTE_LAUNCH_LISTENER_SCRIPT } from "./tunnel.ts";

const listenerPrelude = () => {
  const env = buildRemoteNodeEnvScript();
  const at = env.indexOf("remote_node_satisfies_engine");
  assert.isAbove(at, 0);
  return `${env.slice(0, at)}${REMOTE_LAUNCH_LISTENER_SCRIPT}`;
};

// A macOS login PATH can omit /usr/sbin. Hide /proc and the real lsof so the
// launch helpers have to find a fake /usr/sbin/lsof, or fail closed.
const runWithoutProc = (lsofBody: string | undefined, script: string) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-lsof-"));
  const sbin = NodePath.join(root, "sbin");
  const empty = NodePath.join(root, "empty");
  const minimal = NodePath.join(root, "minimal");
  NodeFS.mkdirSync(sbin);
  NodeFS.mkdirSync(empty);
  NodeFS.mkdirSync(minimal);
  // The listener pipeline still needs grep. The login PATH under test has that,
  // and nothing else that would satisfy `command -v lsof`.
  NodeFS.symlinkSync("/usr/bin/grep", NodePath.join(minimal, "grep"));
  if (lsofBody !== undefined) {
    NodeFS.writeFileSync(NodePath.join(sbin, "lsof"), lsofBody, { mode: 0o755 });
  }
  const driver = `set -eu
# /sbin is a symlink to usr/sbin on usr-merged hosts. Mounting it afterwards
# would cover the lsof stand-in.
if [ ! -L /sbin ]; then mount --bind ${JSON.stringify(empty)} /sbin; fi
mount --bind ${JSON.stringify(lsofBody === undefined ? empty : sbin)} /usr/sbin
mount -t tmpfs tmpfs /proc
export PATH=${JSON.stringify(minimal)}
GOAT_HOST_WINDOWS=0
${listenerPrelude()}
${script}
`;
  try {
    return NodeChildProcess.spawnSync(
      "unshare",
      ["--user", "--mount", "--map-root-user", "sh", "-c", driver],
      { encoding: "utf8" },
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

// macOS CI has no unshare, and some Linux hosts disable unprivileged user namespaces.
const canIsolateListenerPath =
  HostProcess.Platform.defaultValue() === "linux" &&
  NodeChildProcess.spawnSync("unshare", ["--user", "--map-root-user", "true"], {
    encoding: "utf8",
    timeout: 5_000,
  }).status === 0;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH launch identity", () => {
  it.live("checks the socket PID with noglob enabled and preserves the caller's options", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve, reject) => {
              const listener = NodeHttp.createServer((_req, res) => res.end("ok"));
              listener.once("error", reject);
              listener.listen(0, "127.0.0.1", () => resolve(listener));
            }),
        ),
        (listener) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
      );
      const address = server.address();
      if (address === null || typeof address === "string") assert.fail("Expected a TCP listener");
      const result = NodeChildProcess.spawnSync(
        remoteShell,
        [
          "-c",
          `set -f
GOAT_HOST_WINDOWS=0
${REMOTE_LAUNCH_LISTENER_SCRIPT.replaceAll("@@GOAT_READY_TIMEOUT_MS@@", "60000")}
server_owns_listener ${process.pid} ${address.port} || exit 1
if server_owns_listener "$$" ${address.port}; then exit 2; fi
case "$-" in *f*) ;; *) exit 3 ;; esac
`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
    }).pipe(Effect.scoped),
  );
  it.live.each([false, true])(
    "retries a selection/bind race; foreign descriptor=%s",
    (descriptor) =>
      Effect.gen(function* () {
        const foreign = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve, reject) => {
                const server = NodeHttp.createServer((_req, res) =>
                  res.end(
                    descriptor
                      ? JSON.stringify({
                          environmentId: "foreign",
                          label: "Other environment",
                          platform: { os: "linux", arch: "arm64" },
                          capabilities: {},
                          serverVersion: ARCHIVE.archiveVersion,
                          sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
                          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                        })
                      : "foreign",
                  ),
                );
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.close((error) => (error ? reject(error) : resolve()));
                  server.closeAllConnections();
                }),
            ),
        );
        const address = foreign.address();
        assert.isNotNull(address);
        if (address === null || typeof address === "string") return;
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          contestedPort: address.port,
        });
        const result = yield* f.run("launch");
        if (Result.isFailure(result)) assert.fail(String(result.failure));
        if (Result.isFailure(result)) return;
        assert.notEqual(result.success.port, address.port);
        const record = JSON.parse(
          yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
        );
        assert.equal(record.port, result.success.port);
        assert.equal(Number((yield* f.fs.readFileString(`${f.state}/pid`)).trim()), record.pid);
        assert.include(yield* f.fs.readFileString(`${f.state}/server.log`), "EADDRINUSE");
        assert.isTrue(foreign.listening);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("bounds repeated collisions and preserves the foreign listener", () =>
    Effect.gen(function* () {
      const foreign = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve, reject) => {
              const server = NodeHttp.createServer((_req, res) => res.end("foreign"));
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
              }),
          ),
      );
      const address = foreign.address();
      assert.isNotNull(address);
      if (address === null || typeof address === "string") return;
      const f = yield* makeProtocolFixture({
        live: false,
        kind: "managed",
        oldVersion: ARCHIVE.archiveVersion,
        ssh: SSH_RUNTIME_PROTOCOL_VERSION,
        orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        contestedPort: address.port,
        contestedAttempts: 10,
      });
      const result = yield* f.run("launch");
      assert.isTrue(Result.isFailure(result));
      assert.equal(yield* f.fs.readFileString(`${f.test}/contested-picked`), "3");
      for (const name of ["pid", "port", "managed", "identity"])
        assert.isFalse(yield* f.fs.exists(`${f.state}/${name}`));
      assert.isTrue(foreign.listening);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live(
    "does not retry an unrelated startup failure because an old log mentions EADDRINUSE",
    () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.state}/server.log`, "Previous start: EADDRINUSE\n");
        yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "1");
        const result = yield* f.run("launch");
        assert.isTrue(Result.isFailure(result));
        const events = (yield* f.fs.readFileString(`${f.test}/events`))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(events.filter((event) => event.type === "failed-start").length, 1);
        assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.skipIf(!canIsolateListenerPath)("finds lsof from a minimal PATH that omits /usr/sbin", () => {
    const fake = `#!/bin/sh
pid=
prev=
for arg in "$@"; do
  if [ "$prev" = -p ]; then pid=$arg; fi
  prev=$arg
done
if [ "$pid" = "$EXPECTED" ]; then printf '%s\\n' "$pid"; fi
`;
    const result = runWithoutProc(
      fake,
      `found="$(listener_lsof)"
[ "$found" = /usr/sbin/lsof ]
ensure_listener_path
resolved="$(command -v lsof)"
case "$resolved" in
  /usr/sbin/lsof|/sbin/lsof) ;;
  *) printf 'lsof resolved to %s\\n' "$resolved" >&2; exit 1 ;;
esac
EXPECTED=$$
export EXPECTED
server_owns_listener "$$" 9
if server_owns_listener 1 9; then exit 2; fi
`,
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  });

  it.skipIf(!canIsolateListenerPath)(
    "leaves a server running when a minimal PATH has no listener probe",
    () => {
      const result = runWithoutProc(
        undefined,
        `/bin/sleep 30 &
old=$!
trap 'if kill -0 "$old" 2>/dev/null; then printf left-running; kill "$old" 2>/dev/null || true; else printf already-dead; fi' EXIT
NEEDS_OWNED_UPGRADE=1
LIVE_STATUS=live
ensure_listener_path
if ! listener_probe_available; then
  printf 'Cannot verify the launched GOAT listener: this host needs /proc or lsof. The existing server was left running.\\n' >&2
  exit 1
fi
kill "$old"
printf reached-replacement
`,
      );
      assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
      assert.equal(result.stdout.trim(), "left-running");
      assert.include(
        result.stderr,
        "Cannot verify the launched GOAT listener: this host needs /proc or lsof. The existing server was left running.",
      );
      assert.notInclude(result.stdout, "reached-replacement");
    },
  );
});
