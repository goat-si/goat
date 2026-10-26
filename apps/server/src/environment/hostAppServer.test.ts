import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeAppServerLive } from "./hostAppServer.ts";

/** Whether a server on `baseDir`, in a home whose app server record names `pid`, says the app runs. */
const appServerLive = Effect.fn("test.appServerLive")(function* (input: {
  readonly home: string;
  readonly baseDir: string;
  readonly pid?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  if (input.pid !== undefined) {
    const userdata = `${input.home}/.goat/desktop/userdata`;
    yield* fs.makeDirectory(userdata, { recursive: true });
    yield* fs.writeFileString(
      `${userdata}/server-runtime.json`,
      JSON.stringify({
        version: 1,
        pid: input.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
  }
  const live = yield* makeAppServerLive().pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Effect.provideService(HostProcess.HomeDirectory, input.home),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  return yield* live;
});

it.layer(NodeServices.layer)("app server presence", (it) => {
  it.effect(
    "the SSH host server reports a live GOAT app server beside it, and nothing else does",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-host-app-server-" });
        const sshHome = `${home}/.goat`;
        expect(yield* appServerLive({ home, baseDir: sshHome })).toBe(false);
        expect(yield* appServerLive({ home, baseDir: sshHome, pid: process.ppid })).toBe(true);
        // The app's own server, or one on any other home, never tells clients to leave.
        expect(yield* appServerLive({ home, baseDir: `${sshHome}/desktop` })).toBe(false);
        expect(yield* appServerLive({ home, baseDir: `${home}/elsewhere` })).toBe(false);

        // An app that quit leaves its record behind; its PID no longer runs.
        const exited = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          ChildProcess.make("true", []),
        );
        yield* exited.exitCode;
        expect(yield* appServerLive({ home, baseDir: sshHome, pid: Number(exited.pid) })).toBe(
          false,
        );
      }).pipe(Effect.scoped),
  );
});
