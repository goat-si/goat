import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import {
  focusTaskHeading,
  recordTaskOpener,
  requestTaskFocusReturn,
  restoreTaskOpener,
} from "./taskPaneFocus";

it("does not steal focus after clicking an already open task and rerendering", async () => {
  const state = { opener: null, returning: false };
  function View({ revision }: { revision: number }) {
    return (
      <>
        <button
          onClick={(event) => recordTaskOpener(state, event.currentTarget, "task-1", "task-1")}
        >
          Open
        </button>
        <section data-task-pane="task-1">
          <h2 tabIndex={-1} ref={(element) => focusTaskHeading(state, "task-1", element)}>
            Task
          </h2>
          <button>Keep focus {revision}</button>
        </section>
      </>
    );
  }
  // This isolated focus interaction does not need a router.
  await using screen = await render(<View revision={1} />, { router: false });
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.click(screen.getByRole("button", { name: "Keep focus 1" }));
  await screen.rerender(<View revision={2} />);
  await expect.element(screen.getByRole("button", { name: "Keep focus 2" })).toHaveFocus();
});

it("does not restore focus on a later render when its first attempt has no target", async () => {
  const state = { opener: null, returning: false };
  const opener = document.createElement("button");
  recordTaskOpener(state, opener, "task-2", "missing");
  requestTaskFocusReturn(state);
  restoreTaskOpener(state);
  // This isolated focus interaction does not need a router.
  await using screen = await render(<button data-task-opener="missing">Replacement</button>, {
    router: false,
  });
  restoreTaskOpener(state);
  expect(document.activeElement).not.toBe(
    screen.getByRole("button", { name: "Replacement" }).element(),
  );
});
