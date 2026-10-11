import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live.each([
      ARCHIVE.archiveVersion,
      "2.0.0",
      "1.10.0",
      "1.2.3-preview-z",
      "1.2.3-preview.alpha",
    ])("startup reuses an equal/newer release %s", (version) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: version,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
        const before = yield* f.snapshot;
        assert.isTrue(
          Result.isSuccess(
            yield* f.run("launch", false, { refreshOwnedRuntimeOnFirstConnection: true }),
          ),
        );
        assert.deepEqual(yield* f.snapshot, before);
        assert.isFalse(yield* f.fs.exists(`${f.test}/activity-requests`));
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("refreshes only an older numeric prerelease", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.3-preview.9",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.equal(result.success.refresh, "replaced");
        assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "2");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["pairing", "mcp", "keepExistingRunner"] as const).flatMap((entry) =>
        (entry === "keepExistingRunner" ? [false] : [false, true]).map((prepared) => ({
          entry,
          prepared,
        })),
      ),
    )("secondary $entry vetoes startup refresh; prepared=$prepared", ({ entry, prepared }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
        const before = yield* f.snapshot;
        assert.isTrue(
          Result.isSuccess(
            yield* f.run(
              entry === "keepExistingRunner" ? "launch" : entry,
              entry === "keepExistingRunner",
              { refreshOwnedRuntimeOnFirstConnection: true },
              prepared ? f.retainedPrepared : undefined,
            ),
          ),
        );
        assert.deepEqual(yield* f.snapshot, before);
        assert.isFalse(yield* f.fs.exists(`${f.test}/activity-requests`));
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["pairing", "mcp", "keepExistingRunner"] as const).flatMap((entry) =>
        (entry === "keepExistingRunner" ? [false] : [false, true]).map((prepared) => ({
          entry,
          prepared,
        })),
      ),
    )("secondary $entry cannot adopt legacy ownership; prepared=$prepared", ({ entry, prepared }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          descriptor404: true,
        });
        yield* f.fs.remove(`${f.state}/identity`);
        const before = yield* f.snapshot;
        assert.isTrue(
          Result.isFailure(
            yield* f.run(
              entry === "keepExistingRunner" ? "launch" : entry,
              entry === "keepExistingRunner",
              { refreshOwnedRuntimeOnFirstConnection: true },
              prepared ? f.retainedPrepared : undefined,
            ),
          ),
        );
        assert.deepEqual(yield* f.snapshot, before);
        yield* Effect.sync(() => process.kill(f.pid, 0));
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
