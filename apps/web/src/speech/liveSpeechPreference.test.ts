import { expect, it } from "vite-plus/test";
import { liveSpeechAvailable } from "./liveSpeechPreference";

it("offers live transcription only when the selected model and server support it", () => {
  expect(liveSpeechAvailable(undefined, "parakeet")).toBe(false);
  expect(liveSpeechAvailable({ speechStreamingV1: true }, "parakeet")).toBe(false);
  expect(
    liveSpeechAvailable(
      { speechStreamingV1: true, speechStreamingModelIds: ["parakeet"] },
      "whisper",
    ),
  ).toBe(false);
  expect(
    liveSpeechAvailable(
      { speechStreamingV1: true, speechStreamingModelIds: ["parakeet"] },
      "parakeet",
    ),
  ).toBe(true);
});
