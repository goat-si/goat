import { type ConfirmDialogOptions, type ContextMenuItem } from "@goat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Imported at collection rather than inside the test: the module reads window only when called,
// and its first import pulls the contracts schemas, which is too slow to count against a test on a
// loaded runner.
import { createLocalApi } from "./localApi";

const { showContextMenuFallbackMock, dismissContextMenuMock, requestConfirmDialogMock } =
  vi.hoisted(() => ({
    showContextMenuFallbackMock:
      vi.fn<
        <T extends string>(
          items: readonly ContextMenuItem<T>[],
          position?: { x: number; y: number },
        ) => Promise<T | null>
      >(),
    dismissContextMenuMock: vi.fn<() => void>(),
    requestConfirmDialogMock:
      vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>(),
  }));

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });
});
