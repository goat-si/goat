import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

// A host whose server is stopped but whose last runner names an installed,
// protocol-compatible release (#123).
const stoppedHost = (oldVersion: string) =>
  makeProtocolFixture({
    live: false,
    kind: "managed",
    oldVersion,
    drain: true,
    ssh: SSH_RUNTIME_PROTOCOL_VERSION,
    orchestration: ORCHESTRATION_PROTOCOL_VERSION,
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime upgrade on a stopped host",
  () => {
    it.live("installs and starts the requested release instead of the retained older one", () =>
      Effect.gen(function* () {
        const f = yield* stoppedHost("1.2.2");
        const result = yield* f.run("launch");
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.status, "ready");
          assert.equal(result.success.version, ARCHIVE.archiveVersion);
        }
        assert.equal(f.counters().uploads, 1);
        assert.include(
          yield* f.fs.readFileString(`${f.state}/run-t3.sh`),
          `T3_ARCHIVE_VERSION='${ARCHIVE.archiveVersion}'`,
        );
        const started = (yield* f.fs.readFileString(`${f.test}/events`))
          .split("\n")
          .filter((line) => line.includes('"type":"start"'));
        assert.lengthOf(started, 1);
        assert.include(started[0], `"version":"${ARCHIVE.archiveVersion}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { name: "a secondary launch", oldVersion: "1.2.2", secondary: true },
      { name: "a newer retained release", oldVersion: "2.0.0", secondary: false },
    ])("keeps the retained runtime for $name", ({ oldVersion, secondary }) =>
      Effect.gen(function* () {
        const f = yield* stoppedHost(oldVersion);
        const result = yield* f.run("launch", secondary);
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.equal(result.success.version, oldVersion);
        assert.equal(f.counters().uploads, 0);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("starts the retained runtime when the requested archive cannot be acquired", () =>
      Effect.gen(function* () {
        const f = yield* stoppedHost("1.2.2");
        // No archive directory and no mirror: acquisition fails without network.
        const result = yield* f.run("launch", false, { archiveDirectory: "" });
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.equal(result.success.version, "1.2.2");
        assert.equal(f.counters().uploads, 0);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
