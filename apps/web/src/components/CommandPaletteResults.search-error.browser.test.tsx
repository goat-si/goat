import { useRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { ResolvedKeybindingsConfig } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { Command } from "./ui/command";
import { CommandPaletteVirtualizedResults } from "./CommandPaletteResults";

function Results() {
  const list = useRef<LegendListRef>(null);
  return (
    <Command>
      <CommandPaletteVirtualizedResults
        rows={[{ kind: "label", key: "recent", label: "Recent threads", first: true }]}
        listRef={list}
        isActionsOnly={false}
        keybindings={{} as ResolvedKeybindingsConfig}
        onExecuteItem={() => {}}
        searchFailed
      />
    </Command>
  );
}
it("shows the search error beside retained results", async () => {
  await using screen = await render(<Results />);
  await expect.element(screen.getByText("Recent threads")).toBeInTheDocument();
  await expect.element(screen.getByText("Couldn't search thread messages.")).toBeInTheDocument();
});
