import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import { describe } from "vite-plus/test";
import { makePiRpcConnection } from "./rpc.ts";

describe("PiRpc teardown", () => {
  it.live("signals pi before its stdin reaches EOF", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const cuesPath = `${yield* fileSystem.makeTempDirectoryScoped()}/cues`;
      const script = `
const fs = require("node:fs");
const note = (cue) => fs.appendFileSync(process.argv[1], cue + "\\n");
process.on("SIGTERM", () => note("SIGTERM"));
process.stdin.on("end", () => note("stdin end")).resume();
process.stdout.write('{"type":"ready"}\\n');
`;
      yield* Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: process.execPath,
          args: ["-e", script, cuesPath],
          cwd: undefined,
          env: {},
        });
        assert.equal((yield* Queue.take(connection.events))["type"], "ready");
      }).pipe(Effect.scoped);
      const cues = (yield* fileSystem.readFileString(cuesPath)).split("\n").filter(Boolean);
      assert.deepEqual(cues, ["SIGTERM"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
