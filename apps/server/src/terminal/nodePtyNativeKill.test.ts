import * as NodeModule from "node:module";

import { describe, expect, it, vi } from "vite-plus/test";

// The patched agent is the shared CJS module at call time, so the test drives the shipped code.
const requireCjs = NodeModule.createRequire(import.meta.url);

type NativeKill = (pty: number, useConptyDll: boolean) => void;
type Connect = (...args: ReadonlyArray<unknown>) => { pid: number };
interface AgentState {
  _useConptyDll: boolean;
  _innerPid: number;
  _pty: number;
  _exitCode?: number;
  _pendingPtyInfo?: { pty: number; commandLine: string; cwd: string; env: ReadonlyArray<string> };
  _connectionTimeout?: ReturnType<typeof setTimeout>;
  _ptyNative: { kill: NativeKill };
  _conoutSocketWorker: { dispose: () => void };
  _inSocket: { destroy: () => void; readable: boolean };
  _outSocket: {
    destroy: () => void;
    readable: boolean;
    on: (event: string, listener: () => void) => void;
  };
  _onError: { fire: (error: unknown) => void };
}
interface Agent extends AgentState {
  _completePtyConnection(): void;
  _failPtyConnection(error: Error): void;
  kill(): void;
}

const utils: { loadNativeModule: (name: string) => { module: unknown } } =
  requireCjs("node-pty/lib/utils.js");
const { WindowsPtyAgent }: { WindowsPtyAgent: new (...args: ReadonlyArray<unknown>) => Agent } =
  requireCjs("node-pty/lib/windowsPtyAgent.js");

let connect: Connect = () => ({ pid: 0 });
const loadNative = utils.loadNativeModule;
utils.loadNativeModule = () => ({
  module: {
    connect: (...args: ReadonlyArray<unknown>) => connect(...args),
    startProcess: () => {
      throw new Error("the test builds agents from the prototype");
    },
  },
});
try {
  // One construction caches the fake ConPTY module that connect() reads.
  expect(() => new WindowsPtyAgent("cmd.exe", [], {}, ".", 80, 24, false)).toThrow();
} finally {
  utils.loadNativeModule = loadNative;
}

function agent(useConptyDll = false): {
  agent: Agent;
  nativeKill: ReturnType<typeof vi.fn<NativeKill>>;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  let open = true;
  const nativeKill = vi.fn<NativeKill>(() => {
    if (open) {
      open = false;
      close();
    }
  });
  const state: AgentState = {
    _useConptyDll: useConptyDll,
    _innerPid: 0,
    _pty: 1,
    _pendingPtyInfo: { pty: 1, commandLine: "claude.cmd", cwd: ".", env: [] },
    _ptyNative: { kill: nativeKill },
    _conoutSocketWorker: { dispose: vi.fn() },
    _inSocket: { destroy: vi.fn(), readable: true },
    _outSocket: { destroy: vi.fn(), readable: true, on: vi.fn() },
    _onError: { fire: vi.fn() },
  };
  return {
    agent: Object.assign(Object.create(WindowsPtyAgent.prototype), state),
    nativeKill,
    close,
  };
}

describe("node-pty native kill on a Windows pty", () => {
  const failConnect = () => {
    connect = () => {
      throw new Error("Cannot create process, error code: 2");
    };
  };

  it("a failed connect closes the pseudoconsole once even if killed again", () => {
    for (const useConptyDll of [false, true]) {
      failConnect();
      const { agent: failed, nativeKill, close } = agent(useConptyDll);
      failed._completePtyConnection();
      expect(nativeKill).toHaveBeenCalledWith(1, useConptyDll);
      expect(close).toHaveBeenCalledOnce();
      expect(failed._exitCode).toBe(2);
      expect(failed._onError.fire).toHaveBeenCalledOnce();
      failed.kill();
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("a connection timeout releases the native pty it never connected", () => {
    const { agent: waiting, nativeKill } = agent();
    waiting._failPtyConnection(new Error("Timed out waiting for ConPTY output worker"));
    expect(nativeKill).toHaveBeenCalledWith(1, false);
    expect(waiting._onError.fire).toHaveBeenCalledOnce();
  });

  it("kill() before the deferred connect releases the native pty and the connect never runs", () => {
    const connectSpy = vi.fn<Connect>(() => ({ pid: 0 }));
    connect = connectSpy;
    const { agent: pending, nativeKill } = agent();
    pending.kill();
    pending._completePtyConnection();
    expect(nativeKill).toHaveBeenCalledWith(1, false);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(pending._conoutSocketWorker.dispose).toHaveBeenCalledOnce();
  });

  it("kill() after ConPTY connected still kills the native pty", () => {
    connect = () => ({ pid: 0 });
    const { agent: running, nativeKill } = agent();
    running._completePtyConnection();
    running.kill();
    expect(nativeKill).toHaveBeenCalledWith(1, false);
  });

  it("the conpty.dll kill path releases the native pty before and after connect", () => {
    const { agent: pending, nativeKill: pendingKill } = agent(true);
    pending.kill();
    expect(pendingKill).toHaveBeenCalledWith(1, true);
    connect = () => ({ pid: 0 });
    const { agent: running, nativeKill: runningKill } = agent(true);
    running._completePtyConnection();
    running.kill();
    expect(runningKill).toHaveBeenCalledWith(1, true);
  });
});
