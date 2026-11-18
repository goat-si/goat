import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import { Menu, MenuPopup, MenuTrigger, MenuItem } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useComposerMenuProps } from "./composerEventScope";

it("does not focus the composer when touch closes a nested menu and picker", async () => {
  const matchMedia = window.matchMedia.bind(window);
  using _touch = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => matchMedia(query === "(pointer: coarse)" ? "all" : query));
  const focusAtEnd = vi.fn();
  function Picker() {
    const ref = useRef({ focusAtEnd }) as unknown as ComposerHandleRef;
    return (
      <ComposerHandleContext value={ref}>
        <Nested />
      </ComposerHandleContext>
    );
  }
  function Nested() {
    const props = useComposerMenuProps();
    return (
      <>
        <p>Timeline</p>
        <Popover>
          <PopoverTrigger>Model</PopoverTrigger>
          <PopoverPopup {...props}>
            <Menu>
              <MenuTrigger>Permissions</MenuTrigger>
              <MenuPopup {...props}>
                <MenuItem>Full access</MenuItem>
              </MenuPopup>
            </Menu>
          </PopoverPopup>
        </Popover>
      </>
    );
  }
  await using screen = await render(<Picker />, { router: false }); // no routes involved
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  await userEvent.click(page.getByRole("button", { name: "Permissions" }));
  await expect.element(page.getByRole("menuitem", { name: "Full access" })).toBeInTheDocument();
  await userEvent.click(document.body, { position: { x: 1, y: 1 } });
  await userEvent.click(screen.getByText("Timeline"));
  expect(focusAtEnd).not.toHaveBeenCalled();
});
