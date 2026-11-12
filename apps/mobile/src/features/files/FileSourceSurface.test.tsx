import { act } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { expect, it, vi } from "vite-plus/test";

const navigation = vi.hoisted(() => ({
  remove: null as null | ((event: { data: { action: { type: string } } }) => void),
  dispatch: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: navigation.dispatch }),
  usePreventRemove: (enabled: boolean, remove: typeof navigation.remove) => {
    navigation.remove = enabled ? remove : null;
  },
}));
vi.mock("./SourceFileSurface", () => ({
  SourceFileSurface: (props: {
    selectable?: boolean;
    initialLine?: number | null;
    onLongPressLine?: (line: number) => void;
  }) => (
    <div>
      <p>{props.selectable ? `Selecting at ${props.initialLine}` : "Numbered lines"}</p>
      <p>{props.onLongPressLine ? "Selection available" : "Selection unavailable"}</p>
      <button onClick={() => props.onLongPressLine?.(7)}>Select line 7</button>
    </div>
  ),
}));
import { FileSourceSurface } from "./FileSourceSurface";

it("opens document selection at the pressed line and returns to that line on Back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  navigation.remove = null;
  navigation.dispatch.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    expect(Platform.OS).toBe("android");
    await act(() => root.render(<FileSourceSurface path="a.ts" contents="a\nb" />));
    expect(container.textContent).toContain("Selection available");
    await act(() => container.querySelector("button")?.click());
    expect(container.textContent).toContain("Selecting at 7");
    expect(navigation.remove).not.toBeNull();
    await act(() => navigation.remove?.({ data: { action: { type: "GO_BACK" } } }));
    expect(container.textContent).toContain("Numbered lines");
    expect(navigation.dispatch).not.toHaveBeenCalled();
    await act(() => container.querySelector("button")?.click());
    await act(() => navigation.remove?.({ data: { action: { type: "REPLACE" } } }));
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "REPLACE" });
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
