import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@goat/contracts/settings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  toast: vi.fn(),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence: mocks }) }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
  useClientSettings,
} from "./useSettings";

let root: Root;
let container: HTMLDivElement;
let result: boolean | undefined;
let save: Promise<void>;
function Probe() {
  const settings = useClientSettings();
  return (
    <button
      onClick={() => {
        save = updateClientSettings({ wordWrap: false }).then((saved) => {
          result = saved;
        });
      }}
    >
      {settings.wordWrap ? "wrapped" : "unwrapped"}
    </button>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  mocks.getClientSettings.mockReset().mockResolvedValue(null);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  result = undefined;
  container = document.createElement("div");
  root = createRoot(container);
  await act(() => root.render(<Probe />));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("publishes immediately, rolls back with one failure toast and supports retry", async () => {
  let rejectWrite!: (error: Error) => void;
  mocks.setClientSettings.mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectWrite = reject;
    }),
  );
  const button = container.querySelector("button")!;
  await act(async () => {
    button.click();
  });
  expect(button.textContent).toBe("unwrapped");
  expect(result).toBeUndefined();
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => {
    rejectWrite(new Error("disk full"));
    await save;
  });
  expect(result).toBe(false);
  expect(button.textContent).toBe("wrapped");
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Setting not saved",
    description: "Could not save settings on this device. Try again.",
  });
  await act(async () => {
    button.click();
    await save;
  });
  expect(result).toBe(true);
  expect(button.textContent).toBe("unwrapped");
  expect(mocks.toast).toHaveBeenCalledTimes(1);
});
