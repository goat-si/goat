import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

// The requested build (ARCHIVE) is stamped at CLIENT_COMMIT. SemVer alone ranks both
// remote versions wrongly against it (#128): a sha identifier sorts above the numbered
// build of its own train, and train names sort alphabetically.
const CLIENT_COMMIT = 1_791_866_417;
const SHA_BUILD = "1.2.3-preview.e17501807";
const OTHER_TRAIN = "1.2.3-dev.84b52e284";
const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};

const host = (input: {
  live: boolean;
  oldVersion: string;
  remoteCommit?: number;
  candidateCommit?: number;
}) =>
  makeProtocolFixture({
    live: input.live,
    kind: "managed",
    oldVersion: input.oldVersion,
    drain: true,
    ...current,
    ...(input.remoteCommit === undefined ? {} : { commitTime: input.remoteCommit }),
    candidateSignals: {
      ...current,
      drain: true,
      ...(input.candidateCommit === undefined ? {} : { commitTime: input.candidateCommit }),
    },
  });

const owningLaunch = (clientCommit: number | null = CLIENT_COMMIT) => ({
  refreshOwnedRuntimeOnFirstConnection: true,
  ...(clientCommit === null ? {} : { archiveCommitTime: clientCommit }),
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH runtime build order", () => {
  it.live.each([SHA_BUILD, OTHER_TRAIN])(
    "refreshes an idle %s that is older by commit time",
    (oldVersion) =>
      Effect.gen(function* () {
        const f = yield* host({
          live: true,
          oldVersion,
          remoteCommit: CLIENT_COMMIT - 3600,
          candidateCommit: CLIENT_COMMIT,
        });
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

  it.live("leaves an older runtime that is busy running and attaches to it", () =>
    Effect.gen(function* () {
      const f = yield* host({
        live: true,
        oldVersion: SHA_BUILD,
        remoteCommit: CLIENT_COMMIT - 3600,
        candidateCommit: CLIENT_COMMIT,
      });
      yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.status, "ready");
      assert.equal(result.success.pending?.reason, "busy");
      assert.deepEqual(yield* f.snapshot, before);
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      for (const type of ["self-stop", "supervise", "stop"])
        assert.notInclude(events, `"type":"${type}"`);
      yield* Effect.sync(() => process.kill(f.pid, 0));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each([
    // SemVer would call this one older; its commit is newer.
    {
      name: "a newer build of another train",
      oldVersion: OTHER_TRAIN,
      remoteCommit: CLIENT_COMMIT + 60,
    },
    { name: "a newer sha build", oldVersion: SHA_BUILD, remoteCommit: CLIENT_COMMIT + 60 },
    { name: "an unstamped build", oldVersion: SHA_BUILD, remoteCommit: undefined },
    {
      name: "an unstamped build of another train",
      oldVersion: OTHER_TRAIN,
      remoteCommit: undefined,
    },
  ])("attaches to $name without draining or replacing it", ({ oldVersion, remoteCommit }) =>
    Effect.gen(function* () {
      const f = yield* host({
        live: true,
        oldVersion,
        ...(remoteCommit === undefined ? {} : { remoteCommit }),
        candidateCommit: CLIENT_COMMIT,
      });
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.version, oldVersion);
      assert.isUndefined(result.success.pending);
      assert.deepEqual(yield* f.snapshot, before);
      assert.isFalse(yield* f.fs.exists(`${f.test}/activity-requests`));
      assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("an unstamped client never refreshes a stamped older runtime", () =>
    Effect.gen(function* () {
      const f = yield* host({
        live: true,
        oldVersion: SHA_BUILD,
        remoteCommit: CLIENT_COMMIT - 3600,
      });
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false, owningLaunch(null));
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.version, SHA_BUILD);
      assert.deepEqual(yield* f.snapshot, before);
      assert.isFalse(yield* f.fs.exists(`${f.test}/activity-requests`));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("the remote guard refuses a refresh its own unstamped candidate cannot order", () =>
    Effect.gen(function* () {
      // The client's stamp says the host is older, but the uploaded build carries none.
      const f = yield* host({
        live: true,
        oldVersion: SHA_BUILD,
        remoteCommit: CLIENT_COMMIT - 3600,
      });
      const before = yield* f.snapshot;
      assert.isTrue(Result.isFailure(yield* f.run("launch", false, owningLaunch())));
      assert.deepEqual(yield* f.snapshot, before);
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      for (const type of ["drain", "self-stop", "supervise", "stop"])
        assert.notInclude(events, `"type":"${type}"`);
      yield* Effect.sync(() => process.kill(f.pid, 0));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each([
    { name: "an older", remoteCommit: CLIENT_COMMIT - 3600 },
    // A build without a commit time predates stamping; with nothing running it counts older.
    { name: "an unstamped", remoteCommit: undefined },
  ])("a stopped host installs the requested build over $name retained one", ({ remoteCommit }) =>
    Effect.gen(function* () {
      const f = yield* host({
        live: false,
        oldVersion: SHA_BUILD,
        ...(remoteCommit === undefined ? {} : { remoteCommit }),
        candidateCommit: CLIENT_COMMIT,
      });
      const result = yield* f.run("launch", false, owningLaunch());
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.version, ARCHIVE.archiveVersion);
      assert.equal(f.counters().uploads, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each([
    { name: "a newer retained build", remoteCommit: CLIENT_COMMIT + 60, client: CLIENT_COMMIT },
    {
      name: "an unstamped retained build for an unstamped client",
      remoteCommit: undefined,
      client: null,
    },
  ])("a stopped host keeps $name", ({ remoteCommit, client }) =>
    Effect.gen(function* () {
      const f = yield* host({
        live: false,
        oldVersion: OTHER_TRAIN,
        ...(remoteCommit === undefined ? {} : { remoteCommit }),
        candidateCommit: CLIENT_COMMIT,
      });
      const result = yield* f.run("launch", false, owningLaunch(client));
      if (Result.isFailure(result)) throw result.failure;
      assert.equal(result.success.version, OTHER_TRAIN);
      assert.equal(f.counters().uploads, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
