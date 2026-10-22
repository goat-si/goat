import type { DesktopBridge } from "@goat/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

const ipc = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  invoke: vi.fn<(channel: string, input: unknown) => Promise<unknown>>(),
  listeners: new Map<string, Set<(event: unknown, id: unknown) => void>>(),
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: () => {} }));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, bridge: DesktopBridge) => {
      if (name === "desktopBridge") ipc.bridge = bridge;
    },
  },
  ipcRenderer: {
    sendSync: () => null,
    invoke: ipc.invoke,
    on: (channel: string, listener: (event: unknown, id: unknown) => void) => {
      const listeners = ipc.listeners.get(channel) ?? new Set();
      listeners.add(listener);
      ipc.listeners.set(channel, listeners);
    },
    removeListener: (channel: string, listener: (event: unknown, id: unknown) => void) => {
      const listeners = ipc.listeners.get(channel);
      listeners?.delete(listener);
      if (listeners?.size === 0) ipc.listeners.delete(channel);
    },
  },
  webFrame: {},
  webUtils: {},
}));

beforeAll(async () => {
  vi.stubGlobal("window", { addEventListener: () => {} });
  await import("./preload.ts");
  vi.unstubAllGlobals();
});

const target = { alias: "box", hostname: "box.test", username: null, port: null };
const bootstrap = {
  target,
  httpBaseUrl: "http://127.0.0.1:3201/",
  wsBaseUrl: "ws://127.0.0.1:3201/",
  pairingToken: null,
};
const answer = (id: unknown) => {
  for (const listener of ipc.listeners.get(IpcChannels.SSH_ENVIRONMENT_ANSWERED_CHANNEL) ?? [])
    listener({}, id);
};
const progress = (value: unknown) => {
  for (const listener of ipc.listeners.get(IpcChannels.SSH_ENVIRONMENT_PROGRESS_CHANNEL) ?? [])
    listener({}, value);
};
const active = {
  operationId: "flight-1",
  phase: "uploading",
  hostAnswered: true,
  remainingMs: 899_000,
} as const;
const terminal = {
  operationId: "flight-1",
  phase: null,
  hostAnswered: true,
  remainingMs: 642_000,
  outcome: "ready",
  attachmentId: "attachment-1",
  runtimeStatus: {
    host: "box",
    state: "ready",
    runtimeVersion: "1.2.3",
    requestedVersion: "1.2.3",
  },
} as const;

beforeEach(() => {
  ipc.invoke.mockReset();
  expect(ipc.listeners.size).toBe(0);
});

describe("SSH preparation progress in preload", () => {
  it("isolates simultaneous requests and never sends their callbacks over IPC", async () => {
    const pending: Array<{ requestId: string; finish: (value: unknown) => void }> = [];
    ipc.invoke.mockImplementation(
      (channel, input) =>
        new Promise((finish) => {
          expect(channel).toBe(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL);
          const cloned = structuredClone(input) as { requestId: string; options: unknown };
          expect(cloned.options).toEqual({ issuePairingToken: false });
          pending.push({ requestId: cloned.requestId, finish });
        }),
    );
    const firstAnswer = vi.fn();
    const secondAnswer = vi.fn();
    const first = ipc.bridge!.ensureSshEnvironment(target, {
      issuePairingToken: false,
      onHostAnswered: firstAnswer,
    });
    const second = ipc.bridge!.ensureSshEnvironment(target, {
      issuePairingToken: false,
      onHostAnswered: secondAnswer,
    });
    expect(pending[0]!.requestId).not.toBe(pending[1]!.requestId);
    answer(pending[1]!.requestId);
    expect(firstAnswer).not.toHaveBeenCalled();
    expect(secondAnswer).toHaveBeenCalledTimes(1);
    answer(pending[1]!.requestId);
    expect(secondAnswer).toHaveBeenCalledTimes(1);
    pending[0]!.finish(bootstrap);
    await first;
    answer(pending[0]!.requestId);
    expect(firstAnswer).not.toHaveBeenCalled();
    pending[1]!.finish(bootstrap);
    await second;
    expect(ipc.listeners.size).toBe(0);
  });

  it("removes progress observers when preparation rejects", async () => {
    ipc.invoke.mockRejectedValueOnce(new Error("SSH login rejected"));
    await expect(
      ipc.bridge!.ensureSshEnvironment(target, { onHostAnswered: vi.fn() }),
    ).rejects.toThrow("SSH login rejected");
    expect(ipc.listeners.size).toBe(0);
  });

  it("subscribes before invoke, strips callbacks, and rehomes caller provenance", async () => {
    const reported = vi.fn();
    const hostAnswered = vi.fn();
    const attemptContext = { supervisorId: "window-1", attemptId: 2, routeId: "ssh:box" };
    ipc.invoke.mockImplementation(async (_channel, input) => {
      const cloned = structuredClone(input) as {
        requestId: string;
        options: unknown;
        caller: unknown;
        attemptContext: unknown;
      };
      expect(cloned.options).toEqual({
        issuePairingToken: true,
        preparedAttachmentId: "attachment-1",
      });
      expect(cloned.caller).toBe("provision");
      expect(cloned.attemptContext).toEqual(attemptContext);
      expect(ipc.listeners.get(IpcChannels.SSH_ENVIRONMENT_ANSWERED_CHANNEL)?.size).toBe(1);
      expect(ipc.listeners.get(IpcChannels.SSH_ENVIRONMENT_PROGRESS_CHANNEL)?.size).toBe(1);
      answer(cloned.requestId);
      progress({ requestId: cloned.requestId, ...active });
      progress({ requestId: cloned.requestId, ...terminal });
      expect(reported.mock.calls).toEqual([[active], [terminal]]);
      return { ...bootstrap, attachmentId: "attachment-1" };
    });
    expect(ipc.bridge!.supportsSshPreparationPhases).toBe(true);
    expect(
      await ipc.bridge!.ensureSshEnvironment(target, {
        issuePairingToken: true,
        preparedAttachmentId: "attachment-1",
        caller: "provision",
        attemptContext,
        onHostAnswered: hostAnswered,
        onPreparationProgress: reported,
      }),
    ).toEqual({ ...bootstrap, attachmentId: "attachment-1" });
    expect(hostAnswered).toHaveBeenCalledTimes(1);
    expect(ipc.listeners.size).toBe(0);
  });

  it("filters malformed and foreign events while isolating two request listeners", async () => {
    const pending: Array<{ requestId: string; finish: (value: unknown) => void }> = [];
    ipc.invoke.mockImplementation(
      (_channel, input) =>
        new Promise((finish) => {
          pending.push({ requestId: (input as { requestId: string }).requestId, finish });
        }),
    );
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = ipc.bridge!.ensureSshEnvironment(target, {
      onPreparationProgress: firstProgress,
    });
    const second = ipc.bridge!.ensureSshEnvironment(target, {
      onPreparationProgress: secondProgress,
    });
    const requestId = pending[1]!.requestId;
    for (const invalid of [
      null,
      {},
      { requestId, ...active, operationId: "" },
      { requestId, ...active, phase: "downloading" },
      { requestId, ...active, remainingMs: -1 },
      { requestId, ...active, remainingMs: 0.5 },
      { requestId, ...active, outcome: "ready" },
      { requestId, ...active, phase: null },
      { requestId, ...terminal, runtimeStatus: { state: "failed" } },
      { requestId, ...terminal, attachmentId: undefined },
      { requestId, ...active, phase: null, outcome: "failed", attachmentId: "stale" },
    ])
      progress(invalid);
    progress({ requestId: "other-request", ...active });
    expect(firstProgress).not.toHaveBeenCalled();
    expect(secondProgress).not.toHaveBeenCalled();
    progress({ requestId, ...active });
    progress({ requestId, ...active, phase: null, outcome: "pending" });
    expect(secondProgress.mock.calls).toEqual([
      [active],
      [{ ...active, phase: null, outcome: "pending" }],
    ]);
    expect(firstProgress).not.toHaveBeenCalled();
    pending[1]!.finish(bootstrap);
    await second;
    progress({ requestId, ...terminal });
    expect(secondProgress).toHaveBeenCalledTimes(2);
    progress({ requestId: pending[0]!.requestId, ...active });
    expect(firstProgress).toHaveBeenCalledOnce();
    pending[0]!.finish(bootstrap);
    await first;
    expect(ipc.listeners.size).toBe(0);
  });

  it("isolates observer exceptions and preserves terminal delivery and the result", async () => {
    const seen: unknown[] = [];
    ipc.invoke.mockImplementation(async (_channel, input) => {
      const { requestId } = input as { requestId: string };
      expect(() => answer(requestId)).not.toThrow();
      expect(() => progress({ requestId, ...active })).not.toThrow();
      expect(() => progress({ requestId, ...terminal })).not.toThrow();
      return bootstrap;
    });
    expect(
      await ipc.bridge!.ensureSshEnvironment(target, {
        onHostAnswered: () => {
          throw new Error("observer gone");
        },
        onPreparationProgress: (value) => {
          seen.push(value);
          throw new Error("observer gone");
        },
      }),
    ).toEqual(bootstrap);
    expect(seen).toEqual([active, terminal]);
    expect(ipc.listeners.size).toBe(0);
  });

  it("cleans up both channels after synchronous invoke failure and prompt cancellation", async () => {
    ipc.invoke.mockImplementationOnce(() => {
      throw new Error("invoke failed");
    });
    await expect(
      ipc.bridge!.ensureSshEnvironment(target, { onPreparationProgress: vi.fn() }),
    ).rejects.toThrow("invoke failed");
    expect(ipc.listeners.size).toBe(0);
    ipc.invoke.mockResolvedValueOnce({
      type: IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
      message: "SSH authentication cancelled.",
    });
    await expect(
      ipc.bridge!.ensureSshEnvironment(target, {
        onHostAnswered: vi.fn(),
        onPreparationProgress: vi.fn(),
      }),
    ).rejects.toThrow("SSH authentication cancelled.");
    expect(ipc.listeners.size).toBe(0);
  });
});
