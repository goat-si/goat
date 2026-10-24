// @effect-diagnostics-next-line nodeBuiltinImport:off - The test drives Node's real Writable lifecycle, which Electron's ClientRequest extends.
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  addIdleDeadline,
  type StartTimer,
  UpdaterRequestStalledError,
} from "./electronRequestTimeout.ts";

// Electron's net.ClientRequest is a Writable with autoDestroy, so ending its body emits
// "finish" and "close" before any response arrives.
class FakeRequest extends NodeStream.Writable {
  readonly abort = vi.fn();
  constructor() {
    super({ autoDestroy: true });
  }
  override _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    done();
  }
  emitResponse(response: FakeResponse) {
    this.emit("response", response);
  }
}

class FakeResponse {
  private readonly listeners = new Map<string, Array<() => void>>();
  on(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function fakeClock() {
  let now = 0;
  const timers = new Set<{ readonly at: number; readonly run: () => void }>();
  const start: StartTimer = (run, delayMs) => {
    const timer = { at: now + delayMs, run };
    timers.add(timer);
    return () => {
      timers.delete(timer);
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(timer);
      timer.run();
    }
  };
  return { start, advance };
}

function setup() {
  const request = new FakeRequest();
  const clock = fakeClock();
  const fail = vi.fn();
  addIdleDeadline(request, fail, 60_000, clock.start);
  return { request, clock, fail };
}

const timedOut = new UpdaterRequestStalledError(60_000);

describe("addIdleDeadline", () => {
  it("regression: a request that sent its body but never gets a response fails at the deadline", async () => {
    const { request, clock, fail } = setup();
    const closed = new Promise<void>((resolve) => request.once("close", resolve));
    request.end();
    await closed;

    clock.advance(60_000);

    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(timedOut);
  });

  it("regression: a feed response that stops sending data fails at the deadline", () => {
    const { request, clock, fail } = setup();
    const response = new FakeResponse();
    request.emitResponse(response);
    response.emit("data");

    clock.advance(60_000);

    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(timedOut);
  });

  it("keeps a download alive while data keeps arriving, and leaves a finished response alone", () => {
    const { request, clock, fail } = setup();
    const response = new FakeResponse();
    request.emitResponse(response);
    for (let chunk = 0; chunk < 5; chunk += 1) {
      clock.advance(45_000);
      response.emit("data");
    }
    response.emit("end");

    clock.advance(600_000);

    expect(request.abort).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});
