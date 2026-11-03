// @effect-diagnostics nodeBuiltinImport:off -- this test exercises Node's child exit callback.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { handleAgentProcess, nodeChildAgentProcess } from "@goat/shared/AgentScope";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { liveInCheckPhase } from "./checkPhase.ts";

it.live("Node child liveness changes in its exit listener and remains false in check phase", () =>
  Effect.gen(function* () {
    const child = NodeChildProcess.spawn("/bin/cat", [], { stdio: ["pipe", "ignore", "ignore"] });
    const exit = new Promise<readonly [boolean, boolean]>((resolve, reject) => {
      child.on("error", reject);
      child.stdin.on("error", reject);
      child.once("exit", () => {
        const inExit = nodeChildAgentProcess(child)?.isRunning() ?? true;
        setImmediate(() => resolve([inExit, nodeChildAgentProcess(child)?.isRunning() ?? true]));
      });
    });
    const process = nodeChildAgentProcess(child);
    expect(process?.isRunning()).toBe(true);
    child.stdin.end();
    expect(yield* Effect.promise(() => exit)).toEqual([false, false]);
    expect(yield* liveInCheckPhase(() => process?.isRunning())).toBe(false);
  }),
);

it.live("effect child liveness changes on exit and remains false in check phase", () =>
  Effect.gen(function* () {
    using emitted = vi.spyOn(NodeChildProcess.ChildProcess.prototype, "emit");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make("/bin/cat", []));
    const process = handleAgentProcess(handle);
    expect(process.isRunning()).toBe(true);
    const child = emitted.mock.instances.find(
      (instance): instance is NodeChildProcess.ChildProcess =>
        instance instanceof NodeChildProcess.ChildProcess && instance.pid === Number(handle.pid),
    );
    if (child === undefined) return yield* Effect.die("spawned child was not observed");
    const exited = new Promise<readonly [boolean, boolean]>((resolve) => {
      child.once("exit", () => {
        const inExit = process.isRunning();
        setImmediate(() => resolve([inExit, process.isRunning()]));
      });
    });
    yield* handle.kill();
    expect(yield* Effect.promise(() => exited)).toEqual([false, false]);
    expect(yield* liveInCheckPhase(() => process.isRunning())).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
