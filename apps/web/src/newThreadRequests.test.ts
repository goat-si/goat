import { describe, expect, it, vi } from "vite-plus/test";

import { provideNewThread, requestNewThread } from "./newThreadRequests";

describe("newThreadRequests", () => {
  it("runs a request made before anything can start a thread once a starter arrives", () => {
    const start = vi.fn();
    requestNewThread();
    requestNewThread();
    const dispose = provideNewThread(start);
    expect(start).toHaveBeenCalledOnce();
    requestNewThread();
    expect(start).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("keeps a request made after its starter unmounted for the next one", () => {
    const first = vi.fn();
    provideNewThread(first)();
    requestNewThread();
    expect(first).not.toHaveBeenCalled();
    const next = vi.fn();
    const dispose = provideNewThread(next);
    expect(next).toHaveBeenCalledOnce();
    dispose();
  });
});
