import type { VoiceTranscriber } from "@goat/client-runtime/voice-input";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

export function getVoiceTranscriber(
  _remoteTranscriber?: VoiceTranscriber | null,
): VoiceTranscriber | null {
  // Android capture is compressed M4A; remote transcription requires canonical PCM WAV.
  return null;
}
