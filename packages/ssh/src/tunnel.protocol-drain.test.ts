import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const OLDER = "1.2.3-preview.9";
const compatible = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};

const events = (f: Pick<Effect.Success<ReturnType<typeof makeProtocolFixture>>, "fs" | "test">) =>
  f.fs.readFileString(`${f.test}/events`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { type: string; version: string; [key: string]: unknown },
        ),
    ),
  );

const describeFailure = (result: Result.Result<unknown, unknown>) =>
  Result.isFailure(result)
    ? JSON.stringify(result.failure, (_key, value: unknown) =>
        value instanceof Error ? { ...value, message: value.message } : value,
      )
    : "";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime drain replacement",
  () => {
    it.live.each(
      (["busy", "unknown"] as const).flatMap((activity) =>
        [false, true].map((confirmed) => ({ activity, confirmed })),
      ),
    )(
      "compatible older $activity, confirmed=$confirmed: force drains only when confirmed",
      ({ activity, confirmed }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            drain: true,
            ...compatible,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, activity);
          yield* f.fs.writeFileString(`${f.test}/drain`, "cancelled");
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: confirmed,
          });
          assert.isTrue(Result.isSuccess(result), describeFailure(result));
          const log = yield* events(f);
          if (confirmed) {
            if (Result.isSuccess(result)) assert.equal(result.success.refresh, "replaced");
            assert.deepInclude(log, {
              type: "drain",
              version: OLDER,
              status: "drained",
              targetVersion: ARCHIVE.archiveVersion,
              force: true,
              grace: 60,
            });
            assert.isFalse(log.some((entry) => entry.type === "activity"));
            assert.isFalse(isAlive(f.pid));
          } else {
            if (Result.isSuccess(result)) assert.equal(result.success.pending?.reason, activity);
            assert.isFalse(
              log.some((entry) =>
                ["drain", "drain-request", "supervise", "self-stop", "stop"].includes(entry.type),
              ),
            );
            assert.deepEqual(yield* f.snapshot, before);
            assert.isTrue(isAlive(f.pid));
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["busy", "unknown"] as const)(
      "the final guard preserves pending when idle becomes %s before drain",
      (activity) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            drain: true,
            ...compatible,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, `idle,${activity}`);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          assert.isTrue(Result.isSuccess(result), describeFailure(result));
          if (Result.isSuccess(result)) assert.equal(result.success.pending?.reason, activity);
          const log = yield* events(f);
          assert.deepEqual(
            log.filter((entry) => entry.type === "activity").map((entry) => entry.value),
            ["idle", activity],
          );
          assert.isFalse(
            log.some((entry) =>
              ["drain", "drain-request", "supervise", "self-stop", "stop"].includes(entry.type),
            ),
          );
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(isAlive(f.pid));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      "newer",
      "external",
      "unordered",
      "newer-incompatible",
      "external-incompatible",
    ] as const)("confirmation cannot replace a %s server", (refusal) =>
      Effect.gen(function* () {
        const version = refusal.startsWith("newer")
          ? "99.0.0"
          : refusal === "unordered"
            ? "1.2.3-dev.deadbeef"
            : OLDER;
        const incompatible = refusal.endsWith("incompatible");
        const f = yield* makeProtocolFixture({
          live: true,
          kind: refusal.startsWith("external") ? "external" : "managed",
          oldVersion: version,
          drain: true,
          ssh: incompatible ? SSH_RUNTIME_PROTOCOL_VERSION - 1 : SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const before = yield* f.snapshot;
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
          confirmReplacement: true,
        });
        if (incompatible) assert.isTrue(Result.isFailure(result));
        else {
          assert.isTrue(Result.isSuccess(result), describeFailure(result));
          if (Result.isSuccess(result)) assert.equal(result.success.version, version);
        }
        const log = yield* events(f);
        assert.isFalse(
          log.some((entry) =>
            ["drain", "drain-request", "supervise", "self-stop", "stop"].includes(entry.type),
          ),
        );
        assert.isTrue(isAlive(f.pid));
        assert.equal((yield* f.snapshot).runtime, before.runtime);
        assert.equal((yield* f.snapshot)["run-t3.sh"], before["run-t3.sh"]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("drains an idle server and replaces it through the supervisor", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ...compatible,
        });
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(result), describeFailure(result));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.refresh, "replaced");
          assert.equal(result.success.port, f.port);
        }
        const log = yield* events(f);
        assert.deepInclude(log, {
          type: "drain",
          version: OLDER,
          status: "drained",
          targetVersion: ARCHIVE.archiveVersion,
          force: false,
          grace: 60,
        });
        assert.deepInclude(log, {
          type: "supervise",
          version: ARCHIVE.archiveVersion,
          status: "replaced",
        });
        // The server stopped itself; no client signalled it.
        assert.isTrue(log.some((entry) => entry.type === "self-stop" && entry.version === OLDER));
        assert.isFalse(log.some((entry) => entry.type === "stop"));
        assert.isFalse(isAlive(f.pid));
        const snapshot = yield* f.snapshot;
        const runtime = JSON.parse(snapshot.runtime ?? "{}") as {
          serverVersion?: string;
          pid?: number;
          port?: number;
        };
        assert.equal(runtime.serverVersion, ARCHIVE.archiveVersion);
        assert.equal(runtime.port, f.port);
        assert.equal(snapshot.pid?.trim(), String(runtime.pid));
        assert.equal(snapshot.managed, "managed\n");
        assert.include(snapshot["run-t3.sh"] ?? "", ARCHIVE.archiveVersion);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "an expired window without confirmation cancels the replacement and keeps the server",
      () =>
        Effect.gen(function* () {
          // Incompatible, so the client must replace it, and busy past the window.
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION - 1,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
          yield* f.fs.writeFileString(`${f.test}/drain`, "cancelled");
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, { replacementGraceSeconds: 5 });
          assert.isTrue(Result.isSuccess(result), describeFailure(result));
          if (Result.isSuccess(result)) {
            assert.equal(result.success.status, "pending");
            assert.equal(result.success.pending?.reason, "busy");
          }
          const log = yield* events(f);
          assert.deepInclude(log, {
            type: "drain",
            version: OLDER,
            status: "cancelled",
            targetVersion: ARCHIVE.archiveVersion,
            force: false,
            grace: 5,
          });
          assert.isFalse(
            log.some(
              (entry) =>
                entry.type === "supervise" || entry.type === "self-stop" || entry.type === "stop",
            ),
          );
          assert.isTrue(isAlive(f.pid));
          assert.deepEqual(yield* f.snapshot, before);
          assert.isFalse(yield* f.fs.exists(`${f.state}/run-t3.previous`));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a confirmed replacement proceeds when work outlasts the window", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION - 1,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        yield* f.fs.writeFileString(`${f.test}/drain`, "cancelled");
        const result = yield* f.run("launch", false, { confirmReplacement: true });
        assert.isTrue(Result.isSuccess(result), describeFailure(result));
        if (Result.isSuccess(result)) assert.equal(result.success.refresh, "replaced");
        const log = yield* events(f);
        assert.deepInclude(log, {
          type: "drain",
          version: OLDER,
          status: "drained",
          targetVersion: ARCHIVE.archiveVersion,
          force: true,
          grace: 60,
        });
        assert.deepInclude(log, {
          type: "supervise",
          version: ARCHIVE.archiveVersion,
          status: "replaced",
        });
        // Draining replaces the idle-only probe: a busy server was never asked for activity.
        assert.isFalse(log.some((entry) => entry.type === "activity"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([false, true])(
      "rolls back when the new one fails to start, confirmed=%s",
      (confirmed) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            drain: true,
            ...compatible,
          });
          yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "");
          if (confirmed) yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
          const oldRunner = yield* f.fs.readFileString(`${f.state}/run-t3.sh`);
          yield* f.fs.writeFileString(
            `${f.home}/.goat/userdata/statev2.sqlite`,
            "before-replacement",
          );
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: confirmed,
          });
          assert.isTrue(Result.isSuccess(result), describeFailure(result));
          if (Result.isSuccess(result)) {
            assert.equal(result.success.version, OLDER);
            assert.equal(result.success.port, f.port);
            assert.isUndefined(result.success.refresh);
          }
          const log = yield* events(f);
          assert.isTrue(
            log.some(
              (entry) => entry.type === "failed-start" && entry.version === ARCHIVE.archiveVersion,
            ),
          );
          assert.deepInclude(log, {
            type: "supervise",
            version: ARCHIVE.archiveVersion,
            status: "rolled-back",
          });
          const snapshot = yield* f.snapshot;
          const runtime = JSON.parse(snapshot.runtime ?? "{}") as {
            serverVersion?: string;
            pid?: number;
          };
          assert.equal(runtime.serverVersion, OLDER);
          assert.notEqual(runtime.pid, f.pid);
          assert.isTrue(isAlive(runtime.pid ?? 0));
          assert.equal(snapshot.pid?.trim(), String(runtime.pid));
          assert.equal(snapshot["run-t3.sh"], oldRunner);
          assert.equal(
            yield* f.fs.readFileString(`${f.home}/.goat/userdata/statev2.sqlite`),
            "before-replacement",
          );
          assert.isFalse(yield* f.fs.exists(`${f.state}/replacement-backup`));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("attaches to an older server that cannot drain instead of refreshing it", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          ...compatible,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(result), describeFailure(result));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, OLDER);
          assert.isUndefined(result.success.refresh);
        }
        const log = yield* events(f);
        assert.isFalse(
          log.some((entry) =>
            ["drain", "drain-request", "stop", "activity", "supervise"].includes(entry.type),
          ),
        );
        assert.isTrue(isAlive(f.pid));
        assert.equal((yield* f.snapshot).runtime, before.runtime);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("never replaces an incompatible server that cannot drain", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION - 1,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run("launch");
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.include(
            String((result.failure as { stderr?: string }).stderr ?? result.failure),
            "cannot drain",
          );
        const log = yield* events(f);
        assert.isFalse(
          log.some((entry) => ["drain", "drain-request", "stop", "supervise"].includes(entry.type)),
        );
        assert.isTrue(isAlive(f.pid));
        assert.deepEqual(yield* f.snapshot, before);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
