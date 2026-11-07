import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerVoiceButton } from "./ComposerVoiceButton";

const buildBox = EnvironmentId.make("build-box");

describe("composer voice button", () => {
  it("records on click and opens dictation options on right click, with no separate options button", async () => {
    const onClick = vi.fn();
    const enable = vi.fn();
    await using screen = await render(
      <ComposerVoiceButton
        onClick={onClick}
        environmentSpeech={{
          label: "Build box",
          selected: false,
          destinations: [{ environmentId: buildBox, label: "Build box" }],
          enable,
          disable: () => {},
          environmentId: buildBox,
          canManage: false,
          resolveContext: async () => null,
        }}
      />,
      // An isolated control without navigation.
      { router: false },
    );
    const mic = screen.getByRole("button", { name: "Record voice input" });
    expect(screen.container.querySelectorAll("button")).toHaveLength(1);

    await userEvent.click(mic);
    expect(onClick).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

    await userEvent.click(mic, { button: "right" });
    await userEvent.click(page.getByRole("menuitemradio", { name: /Transcribe on Build box/ }));
    expect(enable).toHaveBeenCalledWith(buildBox);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
