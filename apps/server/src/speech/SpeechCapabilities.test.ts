import { expect, it } from "vite-plus/test";
import { speechStreamingCapabilities } from "./SpeechCapabilities.ts";

it("advertises live transcription for catalog models that support it", () => {
  expect(speechStreamingCapabilities.speechStreamingV1).toBe(true);
  expect(speechStreamingCapabilities.speechStreamingModelIds).toContain(
    "handy-computer/parakeet-unified-en-0.6b-gguf",
  );
  expect(speechStreamingCapabilities.speechStreamingModelIds).not.toContain(
    "handy-computer/whisper-tiny-gguf",
  );
  expect(speechStreamingCapabilities.speechStreamingModelIds.length).toBeLessThanOrEqual(64);
});
