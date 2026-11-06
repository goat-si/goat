import { useState } from "react";
import type { RuntimeMode } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ComposerFooterModeControls } from "./ComposerFooterControls";
import { runtimeModeConfig } from "./runtimeModeConfig";

it("opens the runtime mode control and selects a supported mode", async () => {
  function Harness() {
    const [mode, setMode] = useState<RuntimeMode>("full-access");
    return (
      <ComposerFooterModeControls
        showInteractionModeToggle={false}
        interactionMode="default"
        runtimeMode={mode}
        runtimeModeOptions={[
          { mode: "full-access", ...runtimeModeConfig["full-access"] },
          { mode: "approval-required", ...runtimeModeConfig["approval-required"] },
        ]}
        onToggleInteractionMode={() => {}}
        onRuntimeModeChange={setMode}
      />
    );
  }
  await using screen = await render(<Harness />, { router: false }); // This control has no route state.
  await userEvent.click(screen.getByRole("combobox", { name: "Runtime mode" }));
  await expect
    .element(page.getByRole("option", { name: /Auto-accept edits/ }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("option", { name: /Supervised/ }));
  await expect
    .element(screen.getByRole("combobox", { name: "Runtime mode" }))
    .toHaveTextContent("Supervised");
});
