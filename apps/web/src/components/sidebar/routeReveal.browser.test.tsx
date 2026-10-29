import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { type SidebarRouteReveal, useActiveRowReveal } from "./routeReveal";

const ROW_HEIGHT_PX = 24;

function RevealList(props: {
  readonly reveal: SidebarRouteReveal;
  readonly rowKeys: ReadonlyArray<string>;
  readonly activeKey: string | null;
  readonly section?: string;
}) {
  const revealActiveRow = useActiveRowReveal(props.reveal, props.activeKey);
  return (
    <div
      role="list"
      aria-label="Threads"
      style={{ height: ROW_HEIGHT_PX * 4, overflowY: "auto", margin: 0 }}
    >
      <div key={props.section ?? "default"}>
        {props.rowKeys.map((key) => (
          <div
            key={key}
            ref={key === props.activeKey ? (row) => revealActiveRow(row, key) : undefined}
            style={{ height: ROW_HEIGHT_PX }}
          >
            <span>{key}</span>
            <button type="button">Action {key}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

const rowKeys = (count: number) => Array.from({ length: count }, (_, index) => `thread-${index}`);
const newReveal = (): SidebarRouteReveal => ({ observedKey: null, pendingKey: null });

describe("useActiveRowReveal", () => {
  it("keeps the scroll position when the active row moves without a route change", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const list = screen.getByRole("list", { name: "Threads" }).element();
    (screen.getByRole("button", { name: "Action thread-0" }).element() as HTMLElement).focus();
    list.scrollTop = 0;
    await screen.rerender(
      <RevealList
        reveal={reveal}
        rowKeys={[...keys.slice(1), keys[0]!]}
        activeKey="thread-0"
        section="settled"
      />,
    );
    expect(list.scrollTop).toBe(0);
  });

  it("scrolls an off-screen row into view when the route opens its thread", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    await expect.element(target).not.toBeInViewport();

    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />);

    await expect.element(target).toBeInViewport();
  });

  it("reveals the active row when it mounts after the shells arrive", async () => {
    const reveal = newReveal();
    // The route already names the thread, but its environment's shells have not
    // listed it yet.
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={rowKeys(5)} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await expect.element(screen.getByText("thread-4", { exact: true })).toBeInTheDocument();

    await screen.rerender(
      <RevealList reveal={reveal} rowKeys={rowKeys(50)} activeKey="thread-40" />,
    );

    await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
  });

  it("reveals a thread reopened after a thread whose row never mounted", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    await expect.element(target).toBeInViewport();
    screen.getByRole("list", { name: "Threads" }).element().scrollTop = 0;
    await expect.element(target).not.toBeInViewport();

    // The route moves to a thread the list does not hold yet, then back.
    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-99" />);
    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />);

    await expect.element(target).toBeInViewport();
  });

  it("reveals the open thread again when the sidebar remounts on the same route", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    {
      await using screen = await render(
        <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
        // No router: the route arrives as the activeKey prop.
        { router: false },
      );
      await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
    }

    // A remount starts the list at the top; the record outlives it with no reveal pending.
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
  });
});
