import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerVoiceButton } from "./ComposerVoiceButton";

const buildBox = EnvironmentId.make("build-box");

describe("composer voice button", () => {
  it("offers the per-device transcription choice only for a supported environment", async () => {
    const setTranscribeAfterStop = vi.fn();
    const speech = {
      label: "Build box",
      selected: true,
      destinations: [{ environmentId: buildBox, label: "Build box" }],
      enable: () => {},
      disable: () => {},
      environmentId: buildBox,
      canManage: false,
      transcribeAfterStop: false,
      setTranscribeAfterStop,
      resolveContext: async () => null,
    };
    await using screen = await render(
      <ComposerVoiceButton
        onClick={() => {}}
        environmentSpeech={{ ...speech, streamingAvailable: false }}
      />,
      // An isolated control without navigation.
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Record voice input" }), {
      button: "right",
    });
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Transcribe after I stop recording" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await screen.rerender(
      <ComposerVoiceButton
        onClick={() => {}}
        environmentSpeech={{ ...speech, streamingAvailable: true }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Record voice input" }), {
      button: "right",
    });
    await userEvent.click(
      page.getByRole("menuitemcheckbox", { name: "Transcribe after I stop recording" }),
    );
    expect(setTranscribeAfterStop).toHaveBeenCalledWith(true);
  });

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
          streamingAvailable: false,
          transcribeAfterStop: false,
          setTranscribeAfterStop: () => {},
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
