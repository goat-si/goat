import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { CommentSpeechControls, type useCommentSpeech } from "./useCommentSpeech";

it("shows the current live transcript without inserting it into a comment", async () => {
  const speech = {
    visible: true,
    destinationLabel: "Fixture",
    voice: {
      isVoiceActive: true,
      isVoiceRecording: true,
      isVoiceStarting: false,
      isVoiceTranscribing: false,
      streamingPreviewText: "live words",
      state: { error: null },
      cancel: () => {},
      confirm: async () => true,
    },
  } as unknown as ReturnType<typeof useCommentSpeech>;
  await using screen = await render(<CommentSpeechControls speech={speech} />, { router: false }); // The comment controls do not navigate.
  await expect.element(screen.getByText("live words")).toBeVisible();
});
