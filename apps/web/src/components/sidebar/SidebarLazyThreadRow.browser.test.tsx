import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { SidebarLazyRow } from "./SidebarLazyThreadRow";

const THREAD_COUNT = 500;
const keys = Array.from({ length: THREAD_COUNT }, (_, index) => `thread-${index}`);

function LazyThreadList(props: { activeKey: string | null }) {
  return (
    <div
      data-slot="scroll-area-viewport"
      data-testid="scroller"
      style={{ height: 360, overflowY: "auto" }}
    >
      <DndContext>
        <SortableContext items={keys}>
          <ul ref={attachSidebarTree} style={{ margin: 0, padding: 0 }}>
            {keys.map((key) => (
              <SidebarLazyRow
                key={key}
                rowKey={key}
                label={key}
                variant="slim"
                eager={key === props.activeKey}
              >
                <li data-testid="mounted-row" style={{ listStyle: "none" }}>
                  <div
                    role="button"
                    tabIndex={0}
                    data-sidebar-row={key}
                    data-testid={`row-${key}`}
                    className="h-9"
                  >
                    {key}
                  </div>
                </li>
              </SidebarLazyRow>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

describe("SidebarLazyRow", () => {
  it("mounts only the rows near the visible sidebar out of 500 threads, plus the active one", async () => {
    await using screen = await render(<LazyThreadList activeKey="thread-400" />, {
      // The list stands alone; routing plays no part in which rows mount.
      router: false,
    });

    await expect.element(screen.getByTestId("row-thread-0")).toBeInTheDocument();
    const mounted = document.querySelectorAll('[data-testid="mounted-row"]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
    expect(document.querySelector('[data-testid="row-thread-400"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="row-thread-401"]')).toBeNull();
  });

  it("mounts rows as the sidebar scrolls to them and keeps the ones already shown", async () => {
    await using screen = await render(<LazyThreadList activeKey={null} />, {
      // The list stands alone; routing plays no part in which rows mount.
      router: false,
    });
    const first = screen.getByTestId("row-thread-0");
    await expect.element(first).toBeInTheDocument();

    const rowHeight = (first.element() as HTMLElement).offsetHeight;
    screen.getByTestId("scroller").element().scrollTop = 300 * rowHeight;

    await expect.element(screen.getByTestId("row-thread-300")).toBeInViewport();
    expect(document.querySelector('[data-testid="row-thread-0"]')).not.toBeNull();
  });

  it("lets the keyboard reach the last of 500 rows and focus its real row", async () => {
    await using screen = await render(<LazyThreadList activeKey={null} />, {
      // The list stands alone; routing plays no part in which rows mount.
      router: false,
    });
    const first = screen.getByTestId("row-thread-0");
    await expect.element(first).toBeInTheDocument();
    (first.element() as HTMLElement).focus();

    await userEvent.keyboard("{End}");

    const last = screen.getByTestId("row-thread-499");
    await expect.element(last).toHaveFocus();
    await expect.element(last).toBeInViewport();
  });
});
