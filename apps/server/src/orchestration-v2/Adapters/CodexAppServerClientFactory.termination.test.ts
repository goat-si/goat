import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { makeCodexAppServerSpawnCommand } from "./CodexAppServerClientFactory.ts";

it.live("scope closure kills a Codex stdio app-server that ignores SIGTERM", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const input = {
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      forceKillAfter: "200 millis" as const,
    };
    const command = yield* makeCodexAppServerSpawnCommand(input);
    const child = yield* spawner.spawn(command).pipe(Scope.provide(scope));
    const ready = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
    expect(Option.getOrThrow(ready)).toBe("ready");
    yield* Scope.close(scope, Exit.void);
    expect(yield* child.isRunning).toBe(false);
    expect(() => process.kill(Number(child.pid), 0)).toThrow();
  }).pipe(Effect.provide(NodeServices.layer)),
);
