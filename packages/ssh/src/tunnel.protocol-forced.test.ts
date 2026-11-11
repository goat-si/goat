import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const OLDER = "1.2.3-preview.9";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The start time the host reports for a PID, as a person approved it. */
const startOf = (pid: number) =>
  NodeChildProcess.execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { LC_ALL: "C", TZ: "UTC" },
  })
    .trim()
    .replace(/\s+/gu, " ");

const events = (f: {
  fs: { readFileString: (path: string) => Effect.Effect<string, unknown> };
  test: string;
}) =>
  f.fs.readFileString(`${f.test}/events`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; version: string }),
    ),
  );

const unverified = {
  live: true,
  kind: "managed",
  oldVersion: "1.2.2",
  ssh: 99,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
  descriptor404: true,
} as const;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced runtime replacement",
  () => {
    it.live(
      "an approved forced update replaces a runtime without a descriptor by its recorded PID and start time",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: { pid: f.pid, port: f.port, startedAt: startOf(f.pid) },
          });
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          if (Result.isSuccess(result)) {
            assert.equal(result.success.status, "ready");
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          }
          assert.isFalse(isAlive(f.pid));
          const after = yield* f.snapshot;
          assert.notEqual(after.pid, `${f.pid}\n`);
          assert.include(after.identity!, `/versions/${ARCHIVE.archiveVersion}/goat serve`);
          const log = yield* events(f);
          assert.equal(
            log.filter((entry) => entry.type === "stop" && entry.version === "1.2.2").length,
            1,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["start time", "port", "uid", "no approval"] as const)(
      "a runtime that fails the %s check is never signalled",
      (mismatch) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          if (mismatch === "uid") yield* f.fs.writeFileString(`${f.test}/foreign-uid`, "4242\n");
          const startedAt = startOf(f.pid);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            ...(mismatch === "no approval"
              ? {}
              : {
                  forceReplace: {
                    pid: f.pid,
                    port: mismatch === "port" ? f.port + 1 : f.port,
                    startedAt: mismatch === "start time" ? "Thu Jan 1 00:00:00 1970" : startedAt,
                  },
                }),
          });
          assert.isTrue(Result.isFailure(result));
          assert.isTrue(isAlive(f.pid));
          assert.deepEqual(yield* f.snapshot, before);
          assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a runtime that ignores SIGTERM is killed after the grace, with its recorded child",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            ...unverified,
            ignoreSigterm: true,
            spawnChild: true,
          });
          const child = Number((yield* f.fs.readFileString(`${f.test}/child-pid`)).trim());
          assert.isTrue(isAlive(child));
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 1,
            forceReplace: { pid: f.pid, port: f.port, startedAt: startOf(f.pid) },
          });
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          assert.isFalse(isAlive(f.pid));
          assert.isFalse(isAlive(child));
          assert.isTrue((yield* events(f)).some((entry) => entry.type === "stop"));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([false, true])(
      "an owned older runtime that cannot drain is replaced only when forced; forced=%s",
      (forced) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            ...(forced
              ? { forceReplace: { pid: f.pid, port: f.port, startedAt: startOf(f.pid) } }
              : {}),
          });
          if (Result.isFailure(result)) throw result.failure;
          if (forced) {
            assert.equal(result.success.status, "ready");
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
            assert.isFalse(isAlive(f.pid));
          } else {
            // Without approval the host keeps the old runtime and attaches to it.
            assert.equal(result.success.version, OLDER);
            assert.equal(result.success.pending?.refreshCause, "drain_unavailable");
            assert.isTrue(isAlive(f.pid));
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
