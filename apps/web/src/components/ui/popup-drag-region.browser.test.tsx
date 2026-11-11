import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { Autocomplete, AutocompleteInput, AutocompletePopup } from "./autocomplete";
import { Combobox, ComboboxInput, ComboboxPopup } from "./combobox";
import { Select, SelectPopup, SelectTrigger } from "./select";

it("marks each popup itself as a non-draggable desktop region", async () => {
  await using screen = await render(
    <>
      <Autocomplete defaultOpen>
        <AutocompleteInput />
        <AutocompletePopup>Autocomplete</AutocompletePopup>
      </Autocomplete>
      <Combobox defaultOpen>
        <ComboboxInput />
        <ComboboxPopup>Combobox</ComboboxPopup>
      </Combobox>
      <Select defaultOpen>
        <SelectTrigger />
        <SelectPopup>Select</SelectPopup>
      </Select>
    </>,
    { router: false }, // The popup components do not use routing.
  );
  for (const slot of ["autocomplete-popup", "combobox-popup", "select-popup"]) {
    const popup = document.querySelector(`[data-slot="${slot}"]`);
    expect(popup?.classList.contains("[-webkit-app-region:no-drag]")).toBe(true);
  }
  expect(screen.container.classList.contains("[-webkit-app-region:no-drag]")).toBe(false);
});
