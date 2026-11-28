import type { NavigationState } from "@react-navigation/native";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../workspace/workspace-detail-selection", () => ({
  setNativelyPoppingWorkspaceRoute: () => {},
}));

import { useCollapsedSplitColumn } from "./useCollapsedSplitColumn";

const home = { key: "home", name: "Home" };
const left = { key: "thread-a", name: "Thread" };
const picked = { key: "thread-b", name: "Thread" };

function routerState(routes: ReadonlyArray<{ key: string; name: string }>) {
  return { key: "stack", index: routes.length - 1, routes } as unknown as NavigationState;
}

it("shows a thread picked while folded Back is still revealing the list", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state = routerState([home, left]);
  const show = vi.fn();
  const navigation = { getState: () => state, dispatch: vi.fn() };
  const hostRef = { current: { show } as never };
  const splitRef: { current: ReturnType<typeof useCollapsedSplitColumn> | undefined } = {
    current: undefined,
  };
  function Columns({
    onSplit,
  }: {
    readonly onSplit: (value: ReturnType<typeof useCollapsedSplitColumn>) => void;
  }) {
    onSplit(
      useCollapsedSplitColumn({
        hostRef,
        usesSplitView: false,
        compactColumn: state.index > 0 ? "secondary" : "primary",
        primaryKey: home.key,
        navigation,
      }),
    );
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(() =>
      root.render(
        <Columns
          onSplit={(value) => {
            splitRef.current = value;
          }}
        />,
      ),
    );
  try {
    render();
    act(() => splitRef.current!.followAppearance("willDisappear", left.key));
    act(() => splitRef.current!.followAppearance("willAppear", home.key));
    // The list is tappable from willAppear, so the next thread is picked before didAppear.
    state = routerState([home, left, picked]);
    render();
    act(() => splitRef.current!.followAppearance("didAppear", home.key));
    expect(navigation.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "POP", source: left.key }),
    );
    // Back's pop keeps the picked thread, so the compact column stays "secondary" across renders.
    state = routerState([home, picked]);
    render();
    expect(show).toHaveBeenLastCalledWith("secondary");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
