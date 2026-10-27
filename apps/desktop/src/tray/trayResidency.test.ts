import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attachCloseToTray,
  closeOutcome,
  statusNotifierHostAvailable,
  type CloseContext,
  type WatcherBus,
} from "./trayResidency.ts";

const open: CloseContext = {
  platform: "win32",
  iconShown: true,
  quitting: false,
  sessionEnding: false,
};

function fakeWindow() {
  const emitter = new NodeEvents.EventEmitter();
  const window = {
    hidden: false,
    destroyed: false,
    closedForReal: 0,
    on: (event: "close", listener: (event: { preventDefault(): void }) => void) =>
      emitter.on(event, listener),
    isDestroyed: () => window.destroyed,
    hide: () => {
      window.hidden = true;
    },
    close: () => {
      if (userClose()) window.closedForReal += 1;
    },
  };
  // Returns whether the close went through, as Electron does when no listener prevents it.
  const userClose = () => {
    let prevented = false;
    emitter.emit("close", { preventDefault: () => (prevented = true) });
    return !prevented;
  };
  return { window, userClose };
}

describe("closeOutcome", () => {
  it("hides on Windows, asks the bus on Linux, and never keeps macOS or a quitting app", () => {
    expect(closeOutcome(open)).toBe("hide");
    expect(closeOutcome({ ...open, platform: "linux" })).toBe("probe");
    expect(closeOutcome({ ...open, platform: "darwin" })).toBe("close");
    expect(closeOutcome({ ...open, iconShown: false })).toBe("close");
    expect(closeOutcome({ ...open, quitting: true })).toBe("close");
    expect(closeOutcome({ ...open, sessionEnding: true })).toBe("close");
  });
});

describe("attachCloseToTray", () => {
  it("hides the window instead of closing it while the icon is shown", () => {
    const { window, userClose } = fakeWindow();
    attachCloseToTray(window, { context: () => open, hostAvailable: async () => true });
    expect(userClose()).toBe(false);
    expect(window.hidden).toBe(true);
  });

  it("lets a quit close the window", () => {
    const { window, userClose } = fakeWindow();
    attachCloseToTray(window, {
      context: () => ({ ...open, quitting: true }),
      hostAvailable: async () => true,
    });
    expect(userClose()).toBe(true);
    expect(window.hidden).toBe(false);
  });

  it("on Linux hides when a panel draws the icon and closes for real when none does", async () => {
    const withHost = fakeWindow();
    const withHostAnswer = Promise.resolve(true);
    attachCloseToTray(withHost.window, {
      context: () => ({ ...open, platform: "linux" }),
      hostAvailable: () => withHostAnswer,
    });
    expect(withHost.userClose()).toBe(false);
    await withHostAnswer;
    await vi.waitFor(() => expect(withHost.window.hidden).toBe(true));

    const withoutHost = fakeWindow();
    const noHostAnswer = Promise.resolve(false);
    attachCloseToTray(withoutHost.window, {
      context: () => ({ ...open, platform: "linux" }),
      hostAvailable: () => noHostAnswer,
    });
    expect(withoutHost.userClose()).toBe(false);
    await noHostAnswer;
    await vi.waitFor(() => expect(withoutHost.window.closedForReal).toBe(1));
    expect(withoutHost.window.hidden).toBe(false);
  });
});

function fakeBus(overrides: Partial<WatcherBus> = {}) {
  const errorListeners: Array<(cause: unknown) => void> = [];
  const bus = {
    disconnected: 0,
    errorListeners,
    onError: (listener: (cause: unknown) => void) => errorListeners.push(listener),
    hostRegistered: async (): Promise<unknown> => true,
    disconnect: () => {
      bus.disconnected += 1;
    },
    emitError: (cause: unknown) => {
      for (const listener of errorListeners) listener(cause);
    },
    ...overrides,
  };
  return bus;
}

describe("statusNotifierHostAvailable", () => {
  it("is true only for a registered host, and always disconnects", async () => {
    const yes = fakeBus();
    expect(await statusNotifierHostAvailable(async () => yes)).toBe(true);
    expect(yes.disconnected).toBe(1);

    const malformed = fakeBus({ hostRegistered: async () => "true" });
    expect(await statusNotifierHostAvailable(async () => malformed)).toBe(false);
    expect(malformed.disconnected).toBe(1);

    const refused = fakeBus({
      hostRegistered: async () => Promise.reject(new Error("ServiceUnknown")),
    });
    expect(await statusNotifierHostAvailable(async () => refused)).toBe(false);
  });

  it("is false without a session bus or when the bus fails mid-call", async () => {
    expect(await statusNotifierHostAvailable(async () => Promise.reject(new Error("no bus")))).toBe(
      false,
    );
    const failing = fakeBus({ hostRegistered: () => new Promise(() => {}) });
    const answer = statusNotifierHostAvailable(async () => failing);
    await vi.waitFor(() => expect(failing.errorListeners).toHaveLength(1));
    failing.emitError(new Error("ECONNRESET"));
    expect(await answer).toBe(false);
    expect(failing.disconnected).toBe(1);
  });

  it("gives up at its deadline", async () => {
    vi.useFakeTimers();
    try {
      const silent = fakeBus({ hostRegistered: () => new Promise(() => {}) });
      const answer = statusNotifierHostAvailable(async () => silent, 750);
      await vi.advanceTimersByTimeAsync(750);
      expect(await answer).toBe(false);
      expect(silent.disconnected).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a bus that connects only after the deadline without asking it anything", async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      const late = fakeBus({
        hostRegistered: async () => {
          asked += 1;
          return true;
        },
      });
      let connect: (bus: WatcherBus) => void = () => {};
      const answer = statusNotifierHostAvailable(
        () => new Promise<WatcherBus>((resolve) => (connect = resolve)),
        750,
      );
      await vi.advanceTimersByTimeAsync(750);
      expect(await answer).toBe(false);
      connect(late);
      await vi.waitFor(() => expect(late.disconnected).toBe(1));
      expect(asked).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
