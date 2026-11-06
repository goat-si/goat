import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkShimmerArbiter,
  FeedEntryShimmerContext,
  useWorkShimmerTurn,
  WorkShimmerArbiterContext,
  type WorkShimmerArbiter,
} from "./work-shimmer-arbiter";

function setup() {
  const turns = new Map<string, boolean>();
  function Label(props: { readonly name: string; readonly eligible?: boolean }) {
    turns.set(props.name, useWorkShimmerTurn(props.eligible ?? true));
    return null;
  }
  function Entry(props: { readonly index: number; readonly children: ReactNode }) {
    return <FeedEntryShimmerContext value={props.index}>{props.children}</FeedEntryShimmerContext>;
  }
  const moving = () => [...turns].filter(([, turn]) => turn).map(([name]) => name);
  return { turns, Label, Entry, moving };
}

async function renderScreen(arbiter: WorkShimmerArbiter | null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const render = (children: ReactNode) =>
    act(async () =>
      root.render(
        <StrictMode>
          <WorkShimmerArbiterContext value={arbiter}>{children}</WorkShimmerArbiterContext>
        </StrictMode>,
      ),
    );
  return { render, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

describe("work shimmer arbiter", () => {
  it("moves only the label in the later feed entry, whatever order labels mount in", async () => {
    const { Label, Entry, moving } = setup();
    await using screen = await renderScreen(createWorkShimmerArbiter());
    await screen.render(
      <Entry index={7}>
        <Label name="live row" />
      </Entry>,
    );
    await screen.render(
      <>
        <Entry index={7}>
          <Label name="live row" />
        </Entry>
        <Entry index={6}>
          <Label name="group toggle" />
        </Entry>
      </>,
    );
    expect(moving()).toEqual(["live row"]);
  });

  it("moves labels outside feed entries only while no feed label is eligible", async () => {
    const { Label, Entry, moving } = setup();
    await using screen = await renderScreen(createWorkShimmerArbiter());
    const tree = (rowEligible: boolean) => (
      <>
        <Label name="setup stage" />
        <Label name="floating status" />
        <Entry index={0}>
          <Label name="thinking" eligible={rowEligible} />
        </Entry>
      </>
    );
    await screen.render(tree(true));
    expect(moving()).toEqual(["thinking"]);
    await screen.render(tree(false));
    expect(moving()).toEqual(["floating status"]);
  });

  it("hands the shimmer to the next label when the owner unmounts or stops being eligible", async () => {
    const { Label, Entry, moving } = setup();
    await using screen = await renderScreen(createWorkShimmerArbiter());
    await screen.render(
      <>
        <Entry index={1}>
          <Label name="earlier" />
        </Entry>
        <Entry index={2}>
          <Label name="later" />
        </Entry>
      </>,
    );
    expect(moving()).toEqual(["later"]);
    await screen.render(
      <>
        <Entry index={1}>
          <Label name="earlier" />
        </Entry>
        <Entry index={2}>
          <Label name="later" eligible={false} />
        </Entry>
      </>,
    );
    expect(moving()).toEqual(["earlier"]);
    await screen.render(null);
    const { Label: Fresh, moving: freshMoving } = setup();
    await screen.render(<Fresh name="remounted" />);
    expect(freshMoving()).toEqual(["remounted"]);
  });

  it("never reports a label as moving when it holds no claim", async () => {
    const { Label, moving } = setup();
    await using screen = await renderScreen(createWorkShimmerArbiter());
    await screen.render(<Label name="ineligible" eligible={false} />);
    expect(moving()).toEqual([]);
  });

  it("tells listeners only when the owner changes", () => {
    const arbiter = createWorkShimmerArbiter();
    const listener = vi.fn();
    arbiter.subscribe(listener);
    arbiter.claim(1, 5);
    arbiter.claim(2, 3);
    arbiter.release(2);
    expect(listener).toHaveBeenCalledTimes(1);
    arbiter.release(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(arbiter.owner()).toBeNull();
  });

  it("lets every eligible label move on screens without an arbiter", async () => {
    const { Label, moving } = setup();
    await using screen = await renderScreen(null);
    await screen.render(
      <>
        <Label name="one" />
        <Label name="two" />
        <Label name="off" eligible={false} />
      </>,
    );
    expect(moving()).toEqual(["one", "two"]);
  });
});
