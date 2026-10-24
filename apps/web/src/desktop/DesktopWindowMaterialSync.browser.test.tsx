import { expect, it } from "vite-plus/test";
import { act, render } from "../../test/render";
import { deferred, materialBridge, materialState } from "../../test/windowMaterial";
import { persistClientSettingsPatch } from "../hooks/useSettings";
import { DesktopWindowMaterialSync } from "./DesktopWindowMaterialSync";

it("keeps the newest pushed revision when the initial read arrives late and cleans up", async () => {
  using fixture = materialBridge();
  const read = deferred<ReturnType<typeof materialState>>();
  fixture.bridge.getWindowMaterialState.mockReturnValueOnce(read.promise);
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() =>
    fixture.push(materialState({ revision: 3, applied: "none", highContrast: true })),
  );
  await act(async () => {
    read.resolve(materialState({ revision: 1 }));
    await read.promise;
  });
  await act(() => fixture.push(materialState({ revision: 2 })));
  expect(document.documentElement.dataset.desktopWindowMaterial).toBe("none");
  expect(document.documentElement.dataset.desktopGlassOpaque).toBe("accessibility");
  await screen.unmount();
  expect(document.documentElement.hasAttribute("data-desktop-client")).toBe(false);
  expect(document.documentElement.hasAttribute("data-desktop-window-material")).toBe(false);
  expect(document.documentElement.hasAttribute("data-desktop-glass-opaque")).toBe(false);
});

it("rehydrates on remount and rejects a stale event after the fresh read", async () => {
  using fixture = materialBridge();
  await using screen = await render(<DesktopWindowMaterialSync />);
  await act(() =>
    fixture.push(materialState({ revision: 4, applied: "none", reason: "fullscreen" })),
  );
  await screen.rerender(<></>);
  fixture.bridge.getWindowMaterialState.mockResolvedValue(materialState({ revision: 5 }));
  await screen.rerender(<DesktopWindowMaterialSync />);
  await act(() =>
    fixture.push(materialState({ revision: 4, applied: "none", reason: "fullscreen" })),
  );
  expect(document.documentElement.dataset.desktopWindowMaterial).toBe("windows-mica");
  await act(() => persistClientSettingsPatch({ glassOpacity: 100 }));
  expect(document.documentElement.dataset.desktopGlassOpaque).toBe("opacity");
  await act(() => persistClientSettingsPatch({ glassOpacity: 80 }));
  expect(document.documentElement.hasAttribute("data-desktop-glass-opaque")).toBe(false);
});
