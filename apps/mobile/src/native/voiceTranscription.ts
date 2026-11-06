import type { VoiceTranscriber } from "@goat/client-runtime/voice-input";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

export async function probeLocalVoiceTranscriber(): Promise<VoiceTranscriber | null> {
  return getLocalVoiceTranscriber();
}

export function getVoiceTranscriber(
  _remoteTranscriber?: VoiceTranscriber | null,
  _localTranscriber?: VoiceTranscriber | null,
): VoiceTranscriber | null {
  // Android capture is compressed M4A; remote transcription requires canonical PCM WAV.
  return null;
}
