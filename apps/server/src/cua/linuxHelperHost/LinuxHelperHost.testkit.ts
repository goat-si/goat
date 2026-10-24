// Frames are built and read as JSON lines, as the helper writes them.
// @effect-diagnostics preferSchemaOverJson:off
/**
 * A scripted Linux helper for the host and client tests: it answers hello and requests at once,
 * from inside write, the way a real helper's answer arrives after its request.
 */
import { COMPUTER_USE_PROTOCOL_VERSION, type ComputerUseReadiness } from "@goat/contracts";

import { detectLinuxSession, linuxCapabilities } from "../linuxHelper/linuxSession.ts";
import type { HelperProcess } from "./LinuxHelperHost.ts";

export const READY: ComputerUseReadiness = {
  grants: { accessibility: "granted", screenCapture: "granted" },
  helper: "authenticated",
  capture: "ready",
  tree: "ready",
  input: "background",
  blockers: [],
  reasons: [],
};

export const CAPABILITIES = linuxCapabilities(
  detectLinuxSession({
    display: ":7",
    waylandDisplay: undefined,
    sessionBus: "unix:path=/run/bus",
    currentDesktop: undefined,
    gnomeShellMajor: null,
  }),
  true,
);

export interface FakeRequest {
  readonly id: string;
  readonly generation: string;
  readonly method: string;
  readonly params: unknown;
}

export interface FakeHelperOptions {
  readonly pid?: number;
  /** The pid hello names; another than pid fails the binding check. */
  readonly bindingPid?: number;
  readonly generation?: string;
  readonly windows?: () => ReadonlyArray<{ pid: number; windowId: number; onScreen?: boolean }>;
  /** Whether a request gets its answer; the rest are left waiting. */
  readonly answers?: (request: FakeRequest) => boolean;
  readonly onRequest?: (request: FakeRequest) => void;
}

export function fakeHelper(options: FakeHelperOptions = {}) {
  const pid = options.pid ?? 4242;
  const generation = options.generation ?? "gen-1";
  let lineListener: ((line: string) => void) | undefined;
  let exitListener: (() => void) | undefined;
  let stopped = false;
  const requests: FakeRequest[] = [];
  const send = (frame: unknown) => lineListener?.(JSON.stringify(frame));
  const answer = (request: FakeRequest): unknown => {
    if (request.method === "permissions") return READY;
    if (request.method === "listWindows") return { windows: options.windows?.() ?? [] };
    if (request.method === "watch") {
      const params = request.params as { watchId: string; targets: unknown };
      return { watchId: params.watchId, watching: params.targets };
    }
    if (request.method === "unwatch") return { watching: [] };
    return { outcome: "refused", reason: "invalidRequest", message: "not scripted" };
  };
  const process: HelperProcess = {
    pid,
    write: (line) => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if ("clientApiVersion" in frame)
        return send({
          serverApiVersion: COMPUTER_USE_PROTOCOL_VERSION,
          binding: { executable: "goat-computer-use", pid: options.bindingPid ?? pid, generation },
          capabilities: CAPABILITIES,
          maxFrameBytes: 1024 * 1024,
        });
      const request = frame as unknown as FakeRequest;
      requests.push(request);
      options.onRequest?.(request);
      if (options.answers?.(request) === false) return;
      send({ id: request.id, generation, result: answer(request) });
    },
    onLine: (listener) => {
      lineListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    stop: () => {
      stopped = true;
    },
  };
  return {
    process,
    requests,
    /** Sends a frame as the helper would, unprompted. */
    send,
    event: (watchId: string, event: unknown, from = generation) =>
      send({ generation: from, watchId, event }),
    exit: () => exitListener?.(),
    stopped: () => stopped,
  };
}
