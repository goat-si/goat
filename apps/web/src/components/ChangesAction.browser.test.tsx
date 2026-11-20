import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { ChangesAction } from "./ChangesAction";

it("shows the breakdown for the totals on the Changes action", async () => {
  const empty = { additions: 0, deletions: 0 };
  // This isolated action does not navigate.
  await using screen = await render(
    <ChangesAction
      onOpenChanges={() => {}}
      changesTotals={{
        baseRef: null,
        insertions: 5,
        deletions: 1,
        breakdown: {
          code: { additions: 3, deletions: 1 },
          tests: { additions: 2, deletions: 0 },
          mocks: empty,
          generated: empty,
          docs: empty,
        },
      }}
    />,
    { router: false },
  );
  await userEvent.hover(screen.getByRole("button", { name: /Changes/ }));
  await expect.element(screen.getByText("Code")).toBeVisible();
  await expect.element(screen.getByText("Tests")).toBeVisible();
});
