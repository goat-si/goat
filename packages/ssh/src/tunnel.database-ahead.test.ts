// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SERVER_EXIT_CODE_DATABASE_AHEAD } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const SENTENCE = `GOAT ${ARCHIVE.archiveVersion} on this host cannot open its data because a newer GOAT build already upgraded it. Update this app or the GOAT runtime on this host, then reconnect.`;

const events = (f: Pick<Effect.Success<ReturnType<typeof makeProtocolFixture>>, "fs" | "test">) =>
  f.fs.readFileString(`${f.test}/events`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; args?: ReadonlyArray<string> }),
    ),
  );

const serveCount = (log: ReadonlyArray<{ type: string; args?: ReadonlyArray<string> }>) =>
  log.filter((event) => event.type === "exec" && event.args?.[0] === "serve").length;

const stderrOf = (failure: unknown) => {
  if (typeof failure === "object" && failure !== null && "stderr" in failure) {
    const stderr = failure.stderr;
    if (typeof stderr === "string") return stderr;
  }
  return String(failure);
};

const lastLine = (stderr: string) =>
  stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? "";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH database-ahead launch",
  () => {
    it.live(
      "reports a database upgraded by a newer build without starting that runtime again",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
          });
          yield* f.fs.writeFileString(
            `${f.test}/serve-exit-${ARCHIVE.archiveVersion}`,
            `${SERVER_EXIT_CODE_DATABASE_AHEAD}\n`,
          );
          const first = yield* f.run("launch");
          assert.isTrue(
            Result.isFailure(first),
            String(Result.isFailure(first) ? first.failure : ""),
          );
          if (Result.isFailure(first)) assert.equal(lastLine(stderrOf(first.failure)), SENTENCE);
          assert.equal(
            (yield* f.fs.readFileString(`${f.state}/database-ahead`)).trim(),
            ARCHIVE.archiveVersion,
          );
          const started = serveCount(yield* events(f));
          assert.isAbove(started, 0);

          const second = yield* f.run("launch");
          assert.isTrue(Result.isFailure(second));
          if (Result.isFailure(second)) assert.equal(lastLine(stderrOf(second.failure)), SENTENCE);
          assert.equal(serveCount(yield* events(f)), started);

          const database = `${f.home}/.goat/userdata/statev2.sqlite`;
          yield* f.fs.makeDirectory(`${f.home}/.goat/userdata`, { recursive: true });
          yield* f.fs.writeFileString(database, "rewritten-by-newer-runtime");
          // 2100-01-01, in seconds: always newer than the marker.
          yield* Effect.sync(() => NodeFS.utimesSync(database, 4_102_444_800, 4_102_444_800));
          const third = yield* f.run("launch");
          assert.isTrue(Result.isFailure(third));
          assert.isAbove(serveCount(yield* events(f)), started);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("classifies an older runtime's migration error the same way", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
        });
        yield* f.fs.writeFileString(
          `${f.test}/serve-exit-${ARCHIVE.archiveVersion}`,
          "1\nMigrationError: Cannot move GOAT migrations onto ids another migration recorded.\n",
        );
        const result = yield* f.run("launch");
        assert.isTrue(
          Result.isFailure(result),
          String(Result.isFailure(result) ? result.failure : ""),
        );
        if (Result.isFailure(result)) assert.equal(lastLine(stderrOf(result.failure)), SENTENCE);
        assert.equal(
          (yield* f.fs.readFileString(`${f.state}/database-ahead`)).trim(),
          ARCHIVE.archiveVersion,
        );
        assert.isAbove(serveCount(yield* events(f)), 0);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
