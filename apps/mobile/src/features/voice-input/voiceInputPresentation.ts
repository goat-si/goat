import type { VoiceInputState } from "@goat/client-runtime/voice-input";

/** Names the device that receives the audio: on-device speech or the connected environment. */
export function voiceTranscriptionDestination(state: VoiceInputState): string | null {
  if (!state.location) return null;
  return state.location.kind === "this-device" ? "on this device" : `on ${state.location.label}`;
}

function transcribedOn(state: VoiceInputState): string {
  const destination = voiceTranscriptionDestination(state);
  return destination ? ` · ${destination}` : "";
}

export type VoiceComposerPresentation = {
  readonly leadingAction: "cancel" | null;
  readonly trailingAction: "mic" | "confirm";
  readonly showsSend: boolean;
  readonly statusKind: "active" | "error" | null;
  readonly statusLabel: string | null;
  readonly confirmationEnabled: boolean;
  /** Where the recording is transcribed, while recording or transcribing. */
  readonly destination: string | null;
};

export function resolveVoiceComposerPresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
): VoiceComposerPresentation {
  return {
    ...resolvePhasePresentation(state, elapsedSeconds),
    destination: voiceTranscriptionDestination(state),
  };
}

function resolvePhasePresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
): Omit<VoiceComposerPresentation, "destination"> {
  switch (state.phase) {
    case "idle":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: null,
        statusLabel: null,
        confirmationEnabled: false,
      };
    case "error":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: "error",
        statusLabel: state.error,
        confirmationEnabled: false,
      };
    case "preparing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Preparing",
        confirmationEnabled: false,
      };
    case "recording": {
      const seconds = Math.max(0, Math.floor(elapsedSeconds));
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${transcribedOn(state)}`,
        confirmationEnabled: true,
      };
    }
    case "transcribing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: `Transcribing${transcribedOn(state)}`,
        confirmationEnabled: false,
      };
  }
}
