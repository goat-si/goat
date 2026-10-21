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
    it.live("a lost drain response leaves an instance fence and returns pending-only", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ...compatible,
        });
        yield* f.shiftHostClock(60);
        yield* f.fs.writeFileString(`${f.test}/drain`, "response-lost");
        const first = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(first), describeFailure(first));
        if (Result.isFailure(first)) return;
        assert.equal(first.success.status, "pending");
        assert.equal(first.success.pending?.reason, "unknown");
        const runtime = JSON.parse(
          yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
        ) as { instanceId: string };
        assert.equal(
          (yield* f.fs.readFileString(`${f.state}/draining`)).trim(),
          runtime.instanceId,
        );
        assert.equal((yield* events(f)).filter((e) => e.type === "drain").length, 1);
        assert.isTrue(isAlive(f.pid));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([false, true])(
      "a lost drain response can be retried after the server resumes, confirmed=%s",
      (confirmed) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            drain: true,
            ...compatible,
          });
          yield* f.fs.writeFileString(`${f.test}/drain`, "response-lost");
          const first = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          assert.isTrue(Result.isSuccess(first), describeFailure(first));
          if (Result.isSuccess(first)) assert.equal(first.success.status, "pending");
          yield* f.shiftHostClock(600);
          yield* f.fs.writeFileString(`${f.test}/drain`, "drained");
          const recovered = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: confirmed,
          });
          assert.isTrue(Result.isSuccess(recovered), describeFailure(recovered));
          if (Result.isSuccess(recovered)) assert.equal(recovered.success.refresh, "replaced");
          assert.isFalse(yield* f.fs.exists(`${f.state}/draining`));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a cancelled drain retry proves a resumed busy server safe to attach", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ...compatible,
        });
        yield* f.fs.writeFileString(`${f.test}/drain`, "response-lost");
        yield* f.run("launch", false, { refreshOwnedRuntimeOnFirstConnection: true });
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        yield* f.fs.writeFileString(`${f.test}/drain`, "cancelled");
        const recovered = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(recovered), describeFailure(recovered));
        if (Result.isSuccess(recovered)) {
          assert.equal(recovered.success.status, "ready");
          assert.equal(recovered.success.pending?.reason, "busy");
          assert.equal(recovered.success.version, OLDER);
        }
        assert.isFalse(yield* f.fs.exists(`${f.state}/draining`));
        assert.isTrue(isAlive(f.pid));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("an orphaned drain fence on a stopped host permits a fresh start", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ...compatible,
        });
        yield* f.fs.writeFileString(`${f.state}/draining`, "departed-instance\n");
        const recovered = yield* f.run("launch");
        assert.isTrue(Result.isSuccess(recovered), describeFailure(recovered));
        if (Result.isSuccess(recovered)) assert.equal(recovered.success.status, "ready");
        assert.isFalse(yield* f.fs.exists(`${f.state}/draining`));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("an active drain remains fenced across owning retries despite HTTP readiness", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ...compatible,
        });
        yield* f.fs.writeFileString(`${f.test}/drain`, "response-lost");
        yield* f.run("launch", false, { refreshOwnedRuntimeOnFirstConnection: true });
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        const retried = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(retried), describeFailure(retried));
        if (Result.isSuccess(retried)) assert.equal(retried.success.status, "pending");
        assert.isTrue(yield* f.fs.exists(`${f.state}/draining`));
        assert.equal((yield* events(f)).filter((e) => e.type === "drain").length, 2);
        assert.isTrue(isAlive(f.pid));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

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
            // A person's confirmation is never an automatic request the runtime may drop.
            assert.deepInclude(log, { type: "drain-body", version: OLDER, automatic: false });
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
        // The first-connection refresh is automatic, so the runtime may arbitrate it.
        assert.deepInclude(log, { type: "drain-body", version: OLDER, automatic: true });
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

    it.live("drops the drain fence after rolling back an incompatible replacement", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION - 1,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "");
        const result = yield* f.run("launch", false, { confirmReplacement: true });
        assert.isTrue(Result.isFailure(result), describeFailure(result));
        if (Result.isFailure(result))
          assert.include(
            String((result.failure as { stderr?: string }).stderr ?? result.failure),
            "was restored and is running, but this app cannot attach",
          );
        const log = yield* events(f);
        assert.deepInclude(log, {
          type: "supervise",
          version: ARCHIVE.archiveVersion,
          status: "rolled-back",
        });
        assert.isFalse(yield* f.fs.exists(`${f.state}/draining`));
        const runtime = JSON.parse(
          yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
        ) as { serverVersion?: string; pid?: number };
        assert.equal(runtime.serverVersion, OLDER);
        assert.isTrue(isAlive(runtime.pid ?? 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["idle", "busy"] as const)(
      "attaches to an older %s server that cannot drain instead of refreshing it",
      (activity) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            ...compatible,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, activity);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          assert.isTrue(Result.isSuccess(result), describeFailure(result));
          if (Result.isSuccess(result)) {
            assert.equal(result.success.version, OLDER);
            assert.equal(result.success.status, "ready");
            assert.deepEqual(result.success.pending, {
              reason: "unknown",
              refreshCause: "drain_unavailable",
              replacement: "older",
              requestedVersion: ARCHIVE.archiveVersion,
              liveVersion: OLDER,
            });
            assert.isUndefined(result.success.refresh);
          }
          const log = yield* events(f);
          assert.isFalse(
            log.some((entry) =>
              ["drain", "drain-request", "stop", "activity", "supervise"].includes(entry.type),
            ),
          );
          assert.isTrue(isAlive(f.pid));
          assert.deepEqual(yield* f.snapshot, before);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { name: "outer drain then inner no-drain", responses: ["real", "compatible 0 -"], calls: 5 },
      {
        name: "final launch recheck",
        responses: ["real", "real", "real", "real", "real", "compatible 0 -"],
        calls: 7,
      },
      { name: "helper failure", responses: ["failure"], calls: 5 },
      { name: "malformed tokens", responses: ["garbage"], calls: 5 },
      { name: "unknown with exact fields", responses: ["unknown 0 -"], calls: 5 },
      { name: "missing instance", responses: ["compatible 1 -"], calls: 5 },
      { name: "invalid instance", responses: ["compatible 1 invalid/token"], calls: 5 },
    ])("defers $name without activity or replacement", ({ responses, calls }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ...compatible,
        });
        yield* f.shiftHostClock(0, true);
        yield* f.setCompat(responses);
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.status, "ready");
        assert.equal(result.success.port, f.port);
        assert.equal(result.success.version, OLDER);
        assert.deepEqual(result.success.pending, {
          reason: "unknown",
          refreshCause: "drain_unavailable",
          replacement: "older",
          requestedVersion: ARCHIVE.archiveVersion,
          liveVersion: OLDER,
        });
        assert.equal(Number(yield* f.fs.readFileString(`${f.test}/compat-requests`)), calls);
        const log = yield* events(f);
        assert.isFalse(
          log.some((entry) =>
            ["drain", "drain-request", "supervise", "self-stop", "stop"].includes(entry.type),
          ),
        );
        assert.equal(log.filter((entry) => entry.type === "activity").length, calls === 7 ? 1 : 0);
        assert.isTrue(isAlive(f.pid));
        assert.deepEqual(yield* f.snapshot, before);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a later positive check clears a prior no-drain classification", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ...compatible,
        });
        yield* f.shiftHostClock(0, true);
        yield* f.setCompat(["real", "compatible 0 -", "real"]);
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.refresh, "replaced");
        assert.isUndefined(result.success.pending);
        assert.include(
          yield* f.fs.readFileString(`${f.test}/events`),
          '"response":"compatible 0 -"',
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["readiness", "ownership-loss", "version", "protocol"] as const)(
      "failed %s proof emits bare pending",
      (action) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            ...compatible,
          });
          let injected = false;
          f.setBeforeCommand((script) =>
            Effect.gen(function* () {
              if (!script.includes('IDENTITY_NEXT="$STATE_DIR/identity.next.$$"')) return;
              injected = true;
              yield* f.fs.writeFileString(
                `${f.test}/pending-proof`,
                action === "version" || action === "protocol" ? `${action}:${OLDER}` : action,
              );
            }),
          );
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(result)) throw result.failure;
          assert.isTrue(injected);
          assert.equal(result.success.status, "pending");
          assert.equal(result.success.port, 0);
          assert.equal(result.success.pending?.refreshCause, "drain_unavailable");
          assert.isTrue(isAlive(f.pid));
          const after = yield* f.snapshot;
          assert.deepEqual({ ...after, managed: null }, { ...before, managed: null });
          assert.equal(after.managed, action === "ownership-loss" ? "external\n" : before.managed);
          const log = yield* events(f);
          if (action === "readiness" || action === "ownership-loss")
            assert.isTrue(log.some((entry) => entry.type === "pending-proof"));
          assert.isFalse(
            log.some((entry) =>
              ["drain", "drain-request", "supervise", "stop", "activity"].includes(entry.type),
            ),
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a hash change at pending emission cannot produce an attachment", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          ...compatible,
        });
        let injected = false;
        f.setBeforeCommand((script) =>
          Effect.sync(() => {
            if (!script.includes('IDENTITY_NEXT="$STATE_DIR/identity.next.$$"')) return;
            injected = true;
            // Folded launch executes its body in a nested shell; inject the race there.
            f.setScriptPrefix(`sh() {
  if [ "\${3:-}" != runtime ]; then command sh "$@"; return; fi
  {
    cat <<'GOAT_PENDING_PROOF'
printf() {
  case "$1" in
    '"reason":"%s","replacement":"%s","requestedVersion":"%s","liveVersion":"%s"')
      command printf '# changed at pending proof\\n' >> "$RUNNER_FILE" ;;
  esac
  command printf "$@"
}
GOAT_PENDING_PROOF
    cat
  } | command sh "$@"
}
`);
          }),
        );
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(result)) throw result.failure;
        assert.isTrue(injected);
        const after = yield* f.snapshot;
        assert.equal(after["run-t3.sh"], before["run-t3.sh"] + "# changed at pending proof\n");
        assert.equal(result.success.status, "pending");
        assert.equal(result.success.port, 0);
        assert.equal(result.success.pending?.refreshCause, "drain_unavailable");
        assert.deepEqual({ ...after, "run-t3.sh": null }, { ...before, "run-t3.sh": null });
        assert.isTrue(isAlive(f.pid));
        const log = yield* events(f);
        assert.isFalse(
          log.some((entry) =>
            ["drain", "drain-request", "supervise", "stop", "activity"].includes(entry.type),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["failure", "garbage", "unknown 0 -"])(
      "%s never fabricates live compatibility",
      (response) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION - 1,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.setCompat([response]);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          assert.isTrue(Result.isFailure(result));
          assert.include(describeFailure(result), "is incompatible; it was left running");
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(isAlive(f.pid));
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
            "is incompatible; it was left running because it cannot drain",
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
