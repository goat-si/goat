import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { protocolExecutable, makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live.each([false, true])(
      "retries a failed publication after confirmed legacy termination; partial=%s",
      (partial) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            descriptor404: true,
          });
          yield* f.fs.remove(`${f.state}/identity`);
          const before = yield* f.snapshot;
          const bin = `${f.test}/mv-bin`;
          yield* f.fs.makeDirectory(bin);
          yield* f.fs.writeFileString(`${f.test}/fail-publication`, "fail");
          yield* f.fs.writeFileString(
            `${bin}/mv`,
            `#!/bin/sh
if [ "$2" = '${f.state}/run-t3.sh' ] && [ -f '${f.test}/fail-publication' ]; then
  case "$1" in '${f.state}'/run-t3.next.*.restore) ;; '${f.state}'/run-t3.next.*)
    ${partial ? '/bin/mv "$@" || exit $?' : ":"}
    printf 'injected final publication failure\\n' >&2; exit 73 ;;
  esac
fi
exec /bin/mv "$@"
`,
          );
          yield* f.fs.chmod(`${bin}/mv`, 0o700);
          f.setRemotePath(`${bin}:${f.test}/identity-bin:${process.env.PATH ?? ""}`);
          assert.isTrue(Result.isFailure(yield* f.run("launch")));
          const failed = yield* f.snapshot;
          assert.equal(failed.pid, null);
          assert.equal(failed.identity, null);
          assert.equal(failed.oldExecutable, before.oldExecutable);
          assert.equal(failed.oldMarker, before.oldMarker);
          if (!partial) assert.equal(failed["run-t3.sh"], before["run-t3.sh"]);
          assert.include(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
          assert.isFalse(
            (yield* f.fs.readDirectory(f.state)).some(
              (name) => name.includes(".next.") || name.includes(".retained."),
            ),
          );
          yield* f.fs.remove(`${f.test}/fail-publication`);
          assert.isTrue(Result.isSuccess(yield* f.run("launch")));
          const after = yield* f.snapshot;
          assert.notEqual(after.pid, before.pid);
          assert.include(after.identity!, `/versions/${ARCHIVE.archiveVersion}/goat serve`);
          assert.include(after["run-t3.sh"]!, `T3_ARCHIVE_VERSION='${ARCHIVE.archiveVersion}'`);
          assert.equal(
            (yield* f.fs.readFileString(`${f.test}/events`)).split('"type":"stop"').length - 1,
            1,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["script", "base dir", "duplicate", "malformed", "prefix", "suffix"] as const)(
      "refuses a legacy Node invocation with wrong %s",
      (failure) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            descriptor404: true,
            nodeMode: true,
          });
          yield* f.fs.remove(`${f.state}/identity`);
          const nextEntry = `${f.home}/new entry.cjs`;
          yield* f.fs.writeFileString(
            nextEntry,
            protocolExecutable(
              "1.2.3",
              {
                ssh: SSH_RUNTIME_PROTOCOL_VERSION,
                orchestration: ORCHESTRATION_PROTOCOL_VERSION,
                nodeReadiness: true,
              },
              f.state,
            ),
          );
          const file = `${f.state}/run-t3.sh`;
          const runner = yield* f.fs.readFileString(file);
          if (failure === "script")
            yield* f.fs.writeFileString(file, runner.replace("old dev", "other dev"));
          if (failure === "duplicate")
            yield* f.fs.writeFileString(
              file,
              runner + "\nT3_NODE_SCRIPT_PATH='/other/entry.cjs'\n",
            );
          if (failure === "malformed")
            yield* f.fs.writeFileString(
              file,
              runner.replace("T3_NODE_SCRIPT_PATH='", 'T3_NODE_SCRIPT_PATH="'),
            );
          if (["base dir", "prefix", "suffix"].includes(failure)) {
            const bin = `${f.test}/wrong-ps`;
            yield* f.fs.makeDirectory(bin);
            yield* f.fs.writeFileString(
              `${bin}/ps`,
              `#!${process.execPath}
const cp=require('node:child_process');
let command=cp.execFileSync('/bin/ps',process.argv.slice(2),{encoding:'utf8'}).trim();
if(process.argv[5]===${JSON.stringify(String(f.pid))}) command=${failure === "base dir" ? `command.replace(${JSON.stringify(`${f.home}/.goat`)},'/other/userdata')` : failure === "prefix" ? "'tail -f '+command" : "command+' --extra'"};
console.log(command);
`,
            );
            yield* f.fs.chmod(`${bin}/ps`, 0o700);
            f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
          }
          const before = yield* f.snapshot;
          assert.isTrue(
            Result.isFailure(yield* f.run("launch", false, { nodeScriptPath: nextEntry })),
          );
          assert.deepEqual(yield* f.snapshot, before);
          yield* Effect.sync(() => process.kill(f.pid, 0));
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["before publication", "before kill", "candidate validation"] as const)(
      "legacy replacement refuses a race/failure %s",
      (boundary) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            descriptor404: true,
          });
          yield* f.fs.remove(`${f.state}/identity`);
          const before = yield* f.snapshot;
          if (boundary === "before kill") {
            const ps = yield* f.fs.readFileString(`${f.test}/identity-bin/ps`);
            yield* f.fs.writeFileString(
              `${f.test}/identity-bin/ps`,
              ps.replace(
                "  printf '%s",
                `  if [ -f '${f.state}/identity' ]; then printf 'external\\n' > '${f.state}/managed'; fi\n  printf '%s`,
              ),
            );
          } else {
            f.setBeforeCommand((script) =>
              script.includes("REQUESTED_RUNNER=")
                ? Effect.gen(function* () {
                    const exe = `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/goat`;
                    const source = yield* f.fs.readFileString(exe);
                    yield* f.fs.writeFileString(
                      exe,
                      boundary === "candidate validation"
                        ? source.replace(
                            'console.log("goat v" + version);',
                            'console.log("goat v0.0.0");',
                          )
                        : source.replace(
                            '  event("version", { published:',
                            `  fs.appendFileSync(${JSON.stringify(`${f.state}/run-t3.sh`)},"# raced\\n");\n  event("version", { published:`,
                          ),
                    );
                  })
                : Effect.void,
            );
          }
          assert.isTrue(Result.isFailure(yield* f.run("launch")));
          yield* Effect.sync(() => process.kill(f.pid, 0));
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
          const after = yield* f.snapshot;
          assert.equal(after.pid, before.pid);
          assert.equal(after.port, before.port);
          assert.equal(after.identity, null);
          if (boundary === "before kill") {
            assert.equal(after["run-t3.sh"], before["run-t3.sh"]);
            assert.equal(after.managed, "external\n");
          } else {
            assert.equal(after.identity, null);
            assert.equal(after.managed, before.managed);
            if (boundary === "before publication") {
              assert.isTrue(after["run-t3.sh"]!.startsWith(before["run-t3.sh"]!));
              assert.include(after["run-t3.sh"]!, "# raced\n");
            } else assert.equal(after["run-t3.sh"], before["run-t3.sh"]);
          }
          assert.isFalse(
            (yield* f.fs.readDirectory(f.state)).some(
              (name) => name.includes(".next.") || name.includes(".retained."),
            ),
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["stale metadata", "descriptor 404"] as const).map((failure) => ({ failure })))(
      "owning launch preserves an unknown server: $failure",
      ({ failure }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 99,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
            descriptor404: failure === "descriptor 404",
          });
          if (failure === "stale metadata") {
            const file = `${f.home}/.goat/userdata/server-runtime.json`;
            const record = JSON.parse(yield* f.fs.readFileString(file));
            yield* f.fs.writeFileString(
              file,
              JSON.stringify({ ...record, serverVersion: "1.2.1" }),
            );
          }
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            const message = String(result.failure);
            assert.include(message, `Cannot verify live GOAT PID=${f.pid} port=${f.port}`);
            assert.include(message, "may predate GOAT SSH runtime protocol metadata");
            assert.include(message, "It was left running");
            assert.include(
              message,
              `If this is your earlier GOAT server, stop it on the remote host (kill ${f.pid}) and reconnect.`,
            );
          }
          assert.deepEqual(yield* f.snapshot, before); // Includes runner publication/ownership/runtime bytes.
          yield* Effect.sync(() => process.kill(f.pid, 0)); // Captured fixture PID still alive.
          // @effect-diagnostics-next-line globalFetchInEffect:off - real fixture loopback observation.
          const root = yield* Effect.promise(() => fetch(`http://127.0.0.1:${f.port}/`));
          assert.equal(root.status, 200);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, '"type":"stop"');
          assert.notInclude(events, '"type":"auth"');
          assert.equal(events.split('"type":"start"').length - 1, 1); // Only the seeded process.
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "refuses same-version retained runner replacement before $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          let replaced = false;
          f.setBeforeCommand((script) => {
            if (replaced || !script.includes('RUNNER_FILE="$STATE_DIR/run-t3.sh"'))
              return Effect.void;
            replaced = true;
            return Effect.gen(function* () {
              const file = `${f.state}/run-t3.sh`;
              const original = yield* f.fs.readFileString(file);
              // Keep exactly the same archive version; if executed, log a distinct side effect.
              const replacement = original.replace(
                "#!/bin/sh\n",
                `#!/bin/sh\nprintf 'replacement-executed\\n' >> '${f.test}/events'\n`,
              );
              assert.notEqual(replacement, original);
              yield* f.fs.writeFileString(file, replacement);
            });
          });
          const before = yield* f.snapshot;
          const result = yield* f.run(entry);
          assert.isTrue(replaced);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.include(String(result.failure), "changed since probe");
          const after = yield* f.snapshot;
          assert.notEqual(after["run-t3.sh"], before["run-t3.sh"]); // Only our injected replacement persists.
          assert.deepEqual({ ...after, "run-t3.sh": before["run-t3.sh"] ?? null }, before);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, "replacement-executed");
          assert.notInclude(events, '"type":"stop"');
          assert.notInclude(events, '"type":"auth"');
          assert.equal(events.split('"type":"start"').length - 1, 1);
          yield* Effect.sync(() => process.kill(f.pid, 0));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        (
          [
            `unknown ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0`,
            `1.2.3 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} garbage garbage`,
            "1.2.3 0 2 0 0",
            "1.2.3 1 -2 0 0",
            "1.2.3 01 2 0 0",
            `1.2.3-01 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0`,
            `1.2.3 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 1234`,
          ] as const
        ).map((tokens) => ({ entry, tokens })),
      ),
    )("rejects malformed own tokens before $entry: $tokens", ({ entry, tokens }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          ownTokens: tokens,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.include(String(result.failure), "Malformed candidate protocol output");
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "serve", "start", "stop"])
          assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
