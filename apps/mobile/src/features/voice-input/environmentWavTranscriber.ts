import {
  VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
  type EnvironmentId,
  type VoiceTranscriptionInput,
} from "@goat/contracts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  uint8ArrayToBase64,
  validateCanonicalVoiceWav,
  type EnvironmentVoiceRequestContext,
  type VoiceTranscriber,
} from "@goat/client-runtime/voice-input";

export function createEnvironmentWavTranscriber(input: {
  environmentId: EnvironmentId;
  locale: string;
  canSend: () => boolean;
  resolveContext: () => EnvironmentVoiceRequestContext | null;
  readAudio: (uri: string, signal: AbortSignal) => Promise<Uint8Array>;
  upload: (
    context: EnvironmentVoiceRequestContext,
    audio: VoiceTranscriptionInput,
    signal: AbortSignal,
    canSend: () => boolean,
  ) => Promise<string>;
}): VoiceTranscriber {
  const check = (signal: AbortSignal) => {
    throwIfVoiceTranscriptionAborted(signal);
    if (!input.canSend())
      throw new VoiceTranscriptionError("cancelled", "Your transcription choice changed.");
  };
  const context = () => {
    const current = input.resolveContext();
    if (!current || current.prepared.environmentId !== input.environmentId)
      throw new VoiceTranscriptionError(
        "unavailable",
        "Connect to the selected voice environment.",
      );
    return current;
  };
  return {
    async prepare({ signal }) {
      check(signal);
      const initial = context();
      return {
        locale: input.locale,
        location: {
          kind: "environment",
          environmentId: input.environmentId,
          label: initial.prepared.label,
        },
        async transcribe(uri, options) {
          check(options.signal);
          const bytes = await input.readAudio(uri, options.signal);
          check(options.signal);
          const audio = validateCanonicalVoiceWav(bytes);
          if (!audio.ok) throw new VoiceTranscriptionError("transcription-failed", audio.reason);
          const text = await input.upload(
            context(),
            {
              audioBase64: uint8ArrayToBase64(audio.value.bytes),
              mimeType: "audio/wav",
              sampleRateHz: VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
              durationMs: audio.value.sampleDurationMs,
              locale: input.locale,
            },
            options.signal,
            input.canSend,
          );
          check(options.signal);
          return text.trim();
        },
      };
    },
  };
}
