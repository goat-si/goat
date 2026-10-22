import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { FileSaveCoordinator, FileSaveSession } from "./fileSaveCoordinator";

function deferred() {
  let resolve!: (result: AtomCommandResult<void, never>) => void;
  const promise = new Promise<AtomCommandResult<void, never>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FileSaveCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("saves an edit made inside the debounce window when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved");
  });

  it.each([false, true])(
    "keeps an edit pending after write permission is removed (closing=%s)",
    async (closeEditor) => {
      vi.useFakeTimers();
      let canWrite = true;
      const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
      const onPendingChange = vi.fn();
      const coordinator = new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: vi.fn(),
      });

      coordinator.change("unsaved");
      canWrite = false;
      if (closeEditor) coordinator.dispose();
      await vi.runAllTimersAsync();

      expect(persist).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith(true);
    },
  );

  it("flushes an edit made while a write was in flight when the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    coordinator.dispose();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("does not flush newer retired contents after a queued save is cancelled", async () => {
    vi.useFakeTimers();
    let cancelWrite!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      cancelWrite = () => resolve(null);
    });
    const persist = vi
      .fn()
      .mockReturnValueOnce(cancelled)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("queued draft");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("newer retired draft");
    coordinator.dispose();
    cancelWrite();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledExactlyOnceWith("queued draft");
  });

  it("retries a failed write when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed")))),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores editor changes emitted after disposal", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.dispose();
    coordinator.change("stale contents");
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();
  });
});

describe("FileSaveSession", () => {
  it("discards recovered drafts in every view before closing", async () => {
    vi.useFakeTimers();
    const session = new FileSaveSession();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const makeCoordinator = () => {
      const coordinator = new FileSaveCoordinator({
        debounceMs: 500,
        persist,
        onPendingChange: vi.fn(),
        onConfirmed: vi.fn(),
      });
      session.coordinators.add(coordinator);
      return coordinator;
    };
    const source = makeCoordinator();
    const markdown = makeCoordinator();
    source.change("stale source draft");
    markdown.change("recovered stale draft");
    session.discard();
    await vi.runAllTimersAsync();
    source.dispose();
    markdown.dispose();
    expect(persist).not.toHaveBeenCalled();
    markdown.change("retired contents");
    expect(session.status).toBe("saved");
    vi.useRealTimers();
  });

  it("serializes version lookup and confirmation across coordinators", async () => {
    const session = new FileSaveSession();
    let version = "loaded";
    let finishFirst!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const versions: string[] = [];
    const first = session.enqueue(async () => {
      versions.push(version);
      await pending;
      version = "first-written";
    });
    const second = session.enqueue(async () => {
      versions.push(version);
    });
    await Promise.resolve();
    expect(versions).toEqual(["loaded"]);
    finishFirst();
    await Promise.all([first, second]);
    expect(versions).toEqual(["loaded", "first-written"]);
  });
});
