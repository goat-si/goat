import { useEffect, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { useEnvironment } from "../state/environments";
import { MAX_UNATTACHED_VOICE_TRANSCRIPTS, voiceSession } from "./voiceSession";

export function GlobalVoiceRecording() {
  const snapshot = useSyncExternalStore(
    voiceSession.subscribe,
    voiceSession.getSnapshot,
    voiceSession.getSnapshot,
  );
  const environment = useEnvironment(snapshot.active?.environmentId ?? null);
  // oxlint-disable-next-line goat/react-effect-budget -- A disconnected destination cannot finish a recording.
  useEffect(() => {
    if (
      snapshot.active?.environmentId &&
      (!environment || environment.connection.phase !== "connected")
    )
      voiceSession.disconnect();
  }, [environment, snapshot.active]);
  // oxlint-disable-next-line goat/react-effect-budget -- Release capture when the authenticated app unmounts.
  useEffect(() => () => voiceSession.disconnect(), []);
  if (!snapshot.active && snapshot.unattached.length === 0) return null;
  return (
    <div className="fixed top-3 right-3 z-50 flex max-w-md flex-col gap-2 rounded-lg border bg-popover p-3 shadow-lg [-webkit-app-region:no-drag]">
      {snapshot.active ? (
        <div className="flex items-center gap-2" role="status">
          <span>
            {snapshot.active.controller.getSnapshot().phase === "transcribing"
              ? "Transcribing voice…"
              : "Voice recording active"}
          </span>
          <Button
            size="sm"
            disabled={snapshot.active.controller.getSnapshot().phase !== "recording"}
            onClick={() => void voiceSession.stop()}
          >
            Stop
          </Button>
          <Button size="sm" variant="outline" onClick={() => voiceSession.disconnect()}>
            Cancel
          </Button>
        </div>
      ) : null}
      {snapshot.unattached.length >= MAX_UNATTACHED_VOICE_TRANSCRIPTS ? (
        <p>Dismiss a saved transcript before starting another recording.</p>
      ) : null}
      {snapshot.unattached.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Transcript cards have no local state and may be identical.
        <div key={`${item.ownerKey}-${index}`}>
          <p>Transcript kept separately because its draft changed or was removed:</p>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{item.text}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(item.text)}
          >
            Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => voiceSession.dismiss(index)}>
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
