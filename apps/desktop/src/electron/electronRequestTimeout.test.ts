import { describe, expect, it, vi } from "vite-plus/test";

import { addResponseDeadline, type StartTimer } from "./electronRequestTimeout.ts";

function fakeRequest() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    abort: vi.fn(),
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

function manualTimer() {
  let run: (() => void) | null = null;
  const start: StartTimer = (callback) => {
    run = callback;
    return () => {
      run = null;
    };
  };
  return { start, fire: () => run?.() };
}

describe("addResponseDeadline", () => {
  it("regression: an updater request that never answers is aborted and fails", () => {
    const request = fakeRequest();
    const timer = manualTimer();
    const fail = vi.fn();
    addResponseDeadline(request, fail, 60_000, timer.start);

    timer.fire();

    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(
      new Error("Request timed out after 60000 ms without a response"),
    );
  });

  it("keeps a request alive once its response starts, so long downloads keep streaming", () => {
    const request = fakeRequest();
    const timer = manualTimer();
    const fail = vi.fn();
    addResponseDeadline(request, fail, 60_000, timer.start);

    request.emit("response");
    timer.fire();

    expect(request.abort).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});
