import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ComposerCommandMenu } from "./ComposerCommandMenu";

it("shows a thread-search error alongside retained suggestions", async () => {
  await using screen = await render(
    <ComposerCommandMenu
      listId="mentions"
      items={[
        {
          id: "cmd",
          type: "slash-command",
          command: "plan",
          label: "Retained suggestion",
          description: "",
        },
      ]}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="path"
      errorText="Couldn't search threads."
      activeItemId={null}
      onHighlightedItemChange={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  await expect.element(screen.getByText("Retained suggestion")).toBeInTheDocument();
  await expect.element(screen.getByText("Couldn't search threads.")).toBeInTheDocument();
});
