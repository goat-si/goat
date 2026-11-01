import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

// #282: two dev builds that differ only by sha have no provable order, so the host used to keep
// a runtime whose CLI predates memory scopes forever, and memory-scoped sessions exited 1 silently.
const CLIENT_COMMIT = 1_791_866_417;
const SHA_BUILD = "1.2.3-dev.637a98351";
const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};

const host = (input: {
  live: boolean;
  memoryScopes: boolean;
  drain?: boolean;
  remoteCommit?: number;
}) =>
  makeProtocolFixture({
    live: input.live,
    kind: "managed",
    oldVersion: SHA_BUILD,
    drain: input.drain ?? true,
    memoryScopes: input.memoryScopes,
    ...current,
    ...(input.remoteCommit === undefined ? {} : { commitTime: input.remoteCommit }),
    candidateSignals: { ...current, drain: true, commitTime: CLIENT_COMMIT },
  });

const owningLaunch = (clientCommit: number | null = CLIENT_COMMIT) => ({
  refreshOwnedRuntimeOnFirstConnection: true,
  ...(clientCommit === null ? {} : { archiveCommitTime: clientCommit }),
});

const memorySession = {
  runtimeModeCeiling: "full-access",
  memoryScopes: ["memory:read", "memory:write"] as const,
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH runtime capability", () => {
  it.live("refreshes an idle unorderable runtime that cannot issue memory scopes", () =>
    Effect.gen(function* () {
      const f = yield* host({ live: true, memoryScopes: false });
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.refresh, "replaced");
      assert.equal(result.success.version, ARCHIVE.archiveVersion);
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      for (const type of ["drain", "self-stop", "supervise"])
        assert.include(events, `"type":"${type}"`);
      assert.notInclude(events, '"type":"stop"');
      assert.notEqual((yield* f.snapshot).pid, before.pid);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("a busy runtime without memory scopes stays attached with a capability replacement", () =>
    Effect.gen(function* () {
      const f = yield* host({ live: true, memoryScopes: false });
      yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.status, "ready");
      assert.equal(result.success.version, SHA_BUILD);
      assert.deepEqual(result.success.pending, {
        reason: "busy",
        replacement: "capability",
        requestedVersion: ARCHIVE.archiveVersion,
        liveVersion: SHA_BUILD,
      });
      assert.deepEqual(yield* f.snapshot, before);
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      for (const type of ["drain", "self-stop", "supervise", "stop"])
        assert.notInclude(events, `"type":"${type}"`);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never replaces a newer runtime, even one without memory scopes", () =>
    Effect.gen(function* () {
      const f = yield* host({ live: true, memoryScopes: false, remoteCommit: CLIENT_COMMIT + 60 });
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.version, SHA_BUILD);
      assert.isUndefined(result.success.pending);
      assert.deepEqual(yield* f.snapshot, before);
      assert.isFalse(yield* f.fs.exists(`${f.test}/activity-requests`));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live(
    "a stopped host installs the requested build over an unorderable one without memory",
    () =>
      Effect.gen(function* () {
        // An unstamped client cannot order the unstamped retained build; only capability decides.
        const f = yield* host({ live: false, memoryScopes: false });
        const result = yield* f.run("launch", false, owningLaunch(null));
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.version, ARCHIVE.archiveVersion);
        assert.equal(f.counters().uploads, 1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("no drain defers an unorderable capability refresh and allows ordinary sessions", () =>
    Effect.gen(function* () {
      const f = yield* host({ live: true, memoryScopes: false, drain: false });
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.status, "ready");
      assert.deepEqual(result.success.pending, {
        reason: "unknown",
        refreshCause: "drain_unavailable",
        replacement: "capability",
        requestedVersion: ARCHIVE.archiveVersion,
        liveVersion: SHA_BUILD,
      });
      const session = yield* f.run("mcp", true);
      if (Result.isFailure(session)) throw session.failure;
      assert.equal(session.success.version, SHA_BUILD);
      assert.deepEqual(yield* f.snapshot, before);
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      for (const type of ["drain", "self-stop", "supervise", "stop", "activity"])
        assert.notInclude(events, `"type":"${type}"`);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("a kept runtime refuses a memory session with a reason the client shows", () =>
    Effect.gen(function* () {
      // Without drain support the runtime is attach-only, so it is kept.
      const f = yield* host({ live: true, memoryScopes: false, drain: false });
      const launched = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(launched)) throw launched.failure;
      assert.equal(launched.success.version, SHA_BUILD);
      const result = yield* f.run("mcp", true, {}, undefined, memorySession);
      if (Result.isSuccess(result)) throw new Error("Expected the memory session to be refused");
      const error = result.failure;
      assert.equal(error._tag, "SshPairingError");
      assert.equal(
        error._tag === "SshPairingError" ? error.reason : undefined,
        "memory-scopes-unsupported",
      );
      assert.include(error.message, `GOAT ${SHA_BUILD} on `);
      assert.include(error.message, "cannot grant memory access to tasks");
      assert.include(error.message, `GOAT ${ARCHIVE.archiveVersion} replaces it`);
      // No session was issued without the grants the task asked for.
      assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"auth"');
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("a runtime with memory scopes issues them under the ceiling in one call", () =>
    Effect.gen(function* () {
      const f = yield* host({ live: true, memoryScopes: true });
      const result = yield* f.run("mcp", true, {}, undefined, memorySession);
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.version, SHA_BUILD);
      const auth = (yield* f.fs.readFileString(`${f.test}/events`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; args?: string[] })
        .filter((event) => event.type === "auth");
      assert.equal(auth.length, 1);
      const args = auth[0]?.args ?? [];
      for (const expected of [
        "memory:read",
        "memory:write",
        "--runtime-mode-ceiling",
        "full-access",
      ])
        assert.include(args, expected);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
