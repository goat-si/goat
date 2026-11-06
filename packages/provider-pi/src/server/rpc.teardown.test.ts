import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe } from "vite-plus/test";
import { makePiRpcConnection } from "./rpc.ts";

describe("PiRpc teardown", () => {
  it.live("keeps stdin open after its input completes until Pi is signalled", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const cuesPath = `${yield* fileSystem.makeTempDirectoryScoped()}/cues`;
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const spawner = ChildProcessSpawner.make((command) =>
        nativeSpawner.spawn(command).pipe(Effect.tap((child) => Deferred.succeed(spawned, child))),
      );
      const script = `
const fs = require("node:fs");
const note = (cue) => fs.appendFileSync(process.argv[1], cue + "\\n");
process.on("SIGTERM", () => { note("SIGTERM"); process.exit(0); });
process.stdin.on("end", () => { note("stdin end"); process.stdout.write('{"type":"eof"}\\n'); });
process.stdin.on("data", () => process.stdout.write('{"type":"probe"}\\n'));
process.stdout.write('{"type":"ready"}\\n');
`;
      yield* Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: process.execPath,
          args: ["-e", script, cuesPath],
          cwd: undefined,
          env: {},
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        assert.equal((yield* Queue.take(connection.events))["type"], "ready");
        const child = yield* Deferred.await(spawned);
        yield* Stream.empty.pipe(Stream.run(child.stdin));
        yield* connection.send({ type: "probe" });
        assert.equal((yield* Queue.take(connection.events))["type"], "probe");
      }).pipe(Effect.scoped);
      const cues = (yield* fileSystem.readFileString(cuesPath)).split("\n").filter(Boolean);
      assert.deepEqual(cues, ["SIGTERM"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
