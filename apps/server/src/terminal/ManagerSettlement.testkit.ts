import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

export const settlementCase = (
  createManager: typeof import("./Manager.test.ts").createManager,
  openInput: typeof import("./Manager.test.ts").openInput,
  layerWithHostPlatform: typeof import("./Manager.test.ts").layerWithHostPlatform,
) =>
  Effect.gen(function* () {
    const { manager, ptyAdapter } = yield* createManager(5, {
      processTable: Effect.succeed([
        { pid: 9000, ppid: 1, name: "zsh" },
        { pid: 100, ppid: 9000, name: "zsh" },
        { pid: 9001, ppid: 1, name: "zsh" },
        { pid: 200, ppid: 9001, name: "node" },
        { pid: 9002, ppid: 1, name: "zsh" },
        { pid: 300, ppid: 9002, name: "zsh" },
        { pid: 301, ppid: 300, name: "sleep" },
        { pid: 9003, ppid: 1, name: "zsh" },
        { pid: 9004, ppid: 1, name: "zsh" },
        { pid: 400, ppid: 9004, name: "node" },
      ]),
    }).pipe(Effect.provide(layerWithHostPlatform("linux")));
    yield* manager.open(openInput({ terminalId: "idle" }));
    yield* manager.open(openInput({ terminalId: "dev-server" }));
    yield* manager.open(openInput({ terminalId: "subshell" }));
    yield* manager.open(openInput({ threadId: "thread-2", stopOnSettle: true }));
    yield* manager.open(openInput({ terminalId: "managed-dev", stopOnSettle: true }));

    yield* manager.closeIdle({ threadId: "thread-1" });

    expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    yield* manager.open(openInput({ terminalId: "managed-dev", stopOnSettle: false }));
    yield* manager.closeOnSettle({ threadId: "thread-1" });
    expect(ptyAdapter.processes[4]?.killed).toBe(false);
    yield* manager.open(openInput({ terminalId: "managed-dev", stopOnSettle: true }));
    yield* manager.closeOnSettle({ threadId: "thread-1" });
    expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });
