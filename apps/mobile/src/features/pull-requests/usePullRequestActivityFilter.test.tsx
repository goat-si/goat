import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({
  preferences: { pullRequestActivityVisibility: { bots: false, resolved: false } },
  saves: [] as Array<{ pullRequestActivityVisibility: { bots: boolean; resolved: boolean } }>,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ _tag: "Success", value: mock.preferences }),
  useAtomSet:
    () =>
    (update: { transform: (current: typeof mock.preferences) => (typeof mock.saves)[number] }) => {
      const next = update.transform(mock.preferences);
      mock.saves.push(next);
      mock.preferences = next;
    },
}));
import { usePullRequestActivityFilter } from "./usePullRequestActivityFilter";

it("keeps a timeline link override transient until the person changes visibility", () => {
  mock.preferences = { pullRequestActivityVisibility: { bots: false, resolved: false } };
  mock.saves = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Screen({ link }: { readonly link?: string }) {
    const view = usePullRequestActivityFilter(link);
    return (
      <div>
        <output>{`${view.filter.kind}:${view.filter.bots}:${view.filter.resolved}`}</output>
        <button onClick={() => view.setFilter({ ...view.filter, kind: "comments" })}>
          Comments
        </button>
        <button onClick={() => view.setFilter({ ...view.filter, bots: false })}>Hide bots</button>
      </div>
    );
  }
  try {
    act(() => root.render(<Screen link="timeline" />));
    expect(container.querySelector("output")?.textContent).toBe("all:true:true");
    expect(mock.saves).toEqual([]);
    act(() => (container.querySelectorAll("button")[0] as HTMLButtonElement).click());
    expect(container.querySelector("output")?.textContent).toBe("comments:true:true");
    expect(mock.saves).toEqual([]);
    act(() => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(mock.saves).toEqual([
      { pullRequestActivityVisibility: { bots: false, resolved: false } },
    ]);
    act(() => root.render(<Screen key="new-screen" />));
    expect(container.querySelector("output")?.textContent).toBe("all:false:false");
  } finally {
    act(() => root.unmount());
  }
});

it("reveals every comment for a reused timeline link without saving the override", () => {
  mock.preferences = { pullRequestActivityVisibility: { bots: false, resolved: false } };
  mock.saves = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Screen() {
    const view = usePullRequestActivityFilter(undefined);
    return (
      <div>
        <output>{`${view.filter.bots}:${view.filter.resolved}`}</output>
        <button onClick={view.showTimeline}>Open comment</button>
        <button onClick={view.clearLink}>Leave comment link</button>
      </div>
    );
  }
  try {
    act(() => root.render(<Screen />));
    expect(container.querySelector("output")?.textContent).toBe("false:false");
    act(() => container.querySelector("button")!.click());
    expect(container.querySelector("output")?.textContent).toBe("true:true");
    expect(mock.saves).toEqual([]);
    act(() => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(container.querySelector("output")?.textContent).toBe("false:false");
    expect(mock.saves).toEqual([]);
  } finally {
    act(() => root.unmount());
  }
});
