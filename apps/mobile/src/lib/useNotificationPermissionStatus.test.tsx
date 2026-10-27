import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  platform: "ios",
  read: vi.fn<() => Promise<{ granted: boolean }>>(),
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("expo-notifications", () => ({ getPermissionsAsync: native.read }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));

import {
  useNotificationPermissionStatus,
  type NotificationStatus,
} from "./useNotificationPermissionStatus";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.platform = "ios";
  native.read.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  let write: (status: NotificationStatus) => void = () => {
    throw new Error("not mounted");
  };
  function Screen() {
    const [status, setStatus] = useNotificationPermissionStatus();
    write = setStatus;
    return <span>{status}</span>;
  }
  const render = () => act(async () => root.render(<Screen />));
  return { root, container, render, write: (status: NotificationStatus) => write(status) };
}

it("reads only on mount and foreground, and never lets an older read overwrite a denial", async () => {
  const { root, container, render, write } = setup();
  const initial = Promise.withResolvers<{ granted: boolean }>();
  const foreground = Promise.withResolvers<{ granted: boolean }>();
  native.read.mockReturnValueOnce(initial.promise).mockReturnValueOnce(foreground.promise);
  try {
    await render();
    await render();
    expect(native.read).toHaveBeenCalledTimes(1);
    expect(native.listeners.size).toBe(1);
    await act(async () => {
      for (const listener of native.listeners) listener("background");
    });
    expect(native.read).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const listener of native.listeners) listener("active");
    });
    await act(async () => foreground.resolve({ granted: false }));
    expect(container.textContent).toBe("disabled");
    await act(async () => initial.resolve({ granted: true }));
    expect(container.textContent).toBe("disabled");
    const pending = Promise.withResolvers<{ granted: boolean }>();
    native.read.mockReturnValueOnce(pending.promise);
    await act(async () => {
      for (const listener of native.listeners) listener("active");
    });
    act(() => write("disabled"));
    await act(async () => pending.resolve({ granted: true }));
    expect(container.textContent).toBe("disabled");
  } finally {
    await act(async () => root.unmount());
    expect(native.listeners.size).toBe(0);
  }
});

it("reports native read failures as disabled and ignores reads settling after unmount", async () => {
  const { root, container, render } = setup();
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});
  native.read.mockRejectedValueOnce(new Error("native permissions unavailable"));
  await render();
  await vi.waitFor(() => expect(container.textContent).toBe("disabled"));
  const pending = Promise.withResolvers<{ granted: boolean }>();
  native.read.mockReturnValueOnce(pending.promise);
  await act(async () => {
    for (const listener of native.listeners) listener("active");
  });
  await act(async () => root.unmount());
  await act(async () => pending.resolve({ granted: true }));
  expect(native.listeners.size).toBe(0);
});

it("does not ask native permissions on unsupported platforms", async () => {
  const { root, container, render } = setup();
  native.platform = "web";
  try {
    await render();
    expect(container.textContent).toBe("unsupported");
    expect(native.read).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
