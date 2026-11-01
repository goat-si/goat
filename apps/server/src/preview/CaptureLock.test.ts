import { expect, it, vi } from "vite-plus/test";

import { answerCall, waitInput, withCaptureLock } from "./CaptureLock.ts";

it("a capture whose deadline passed while it waited never runs, even before its timer fires", async () => {
  const tab = { captureLock: Promise.resolve(), closing: false };
  let ran = false;
  // Its turn comes on the next microtask, before any timer could mark it expired.
  const late = withCaptureLock(
    tab,
    async () => {
      ran = true;
    },
    // Every deadline is a performance timestamp; 0 is the process's start, long past.
    0,
  );
  await expect(late).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
  await tab.captureLock;
  expect(ran).toBe(false);
});

it("a call still unsettled at its deadline is answered half a second later, a wait as never started", async () => {
  vi.useFakeTimers();
  try {
    const never = () => new Promise<never>(() => {});
    const answers: string[] = [];
    const record = (name: string) => (cause: { readonly tag?: string }) => {
      answers.push(`${name}:${cause.tag}`);
    };
    void answerCall({ timeoutMs: 100, operation: "waitFor" }, never).catch(record("wait"));
    void answerCall({ timeoutMs: 100, operation: "click" }, never).catch(record("click"));
    await vi.advanceTimersByTimeAsync(599);
    expect(answers).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(answers.sort()).toEqual([
      "click:PreviewAutomationTimeoutError",
      "wait:PreviewAutomationExecutionError",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("a wait starting late keeps only its call's remaining time and refuses once none is left", () => {
  vi.useFakeTimers();
  try {
    // The call's deadline as answerCall sets it when the browser takes the call.
    let deadline = Number.NaN;
    void answerCall({ timeoutMs: 300, operation: "waitFor" }, (at) => {
      deadline = at;
      return new Promise<never>(() => {});
    }).catch(() => {});
    const request = { input: { text: "Ready" }, timeoutMs: 1_000 };
    expect(waitInput(request, deadline)).toEqual({ text: "Ready", timeoutMs: 300 });
    vi.advanceTimersByTime(300);
    expect(() => waitInput(request, deadline)).toThrow(
      expect.objectContaining({ tag: "PreviewAutomationExecutionError" }),
    );
  } finally {
    vi.useRealTimers();
  }
});
