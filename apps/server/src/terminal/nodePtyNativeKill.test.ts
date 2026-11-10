import * as NodeModule from "node:module";

import { describe, expect, it, vi } from "vite-plus/test";

// The patched agent is the shared CJS module at call time, so the test reads the shipped code.
const requireCjs = NodeModule.createRequire(import.meta.url);
const {
  WindowsPtyAgent,
}: {
  WindowsPtyAgent: {
    prototype: {
      _killConnectedPty(this: {
        _connected: boolean;
        _ptyNative: { kill: (pty: number, useConptyDll: boolean) => void };
        _pty: number;
        _useConptyDll: boolean;
      }): void;
    };
  };
} = requireCjs("node-pty/lib/windowsPtyAgent.js");

const PTY = 1;

function agent(connected: boolean) {
  const nativeKill = vi.fn();
  return {
    nativeKill,
    agent: {
      _connected: connected,
      _ptyNative: { kill: nativeKill },
      _pty: PTY,
      _useConptyDll: false,
    },
  };
}

describe("node-pty native kill on an unconnected pty", () => {
  // regression: #2785 the native kill on a pty that never connected corrupted the Windows heap
  it("leaves the native pty alone when ConPTY never attached a process", () => {
    const { agent: unconnected, nativeKill } = agent(false);
    WindowsPtyAgent.prototype._killConnectedPty.call(unconnected);
    expect(nativeKill).not.toHaveBeenCalled();
  });

  it("kills the native pty once ConPTY attached a process", () => {
    const { agent: connected, nativeKill } = agent(true);
    WindowsPtyAgent.prototype._killConnectedPty.call(connected);
    expect(nativeKill).toHaveBeenCalledWith(PTY, false);
  });
});
