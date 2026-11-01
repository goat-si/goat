import type { useComposerVoiceController } from "./useComposerVoiceController";
import { useEffect } from "react";
import { ArrowUpIcon, CheckIcon, XIcon } from "~/components/solar";
import { MAX_WAVEFORM_SAMPLES } from "../../lib/voiceRecorder";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerVoiceRecorderBarProps {
  readonly controller: ReturnType<typeof useComposerVoiceController>;
  readonly disabled?: boolean;
}

export function ComposerVoiceRecorderBar({ controller, disabled }: ComposerVoiceRecorderBarProps) {
  const route = controller.transcriptionRoute;
  const environmentLabel = useEnvironment(
    route.kind === "environment" ? route.environmentId : null,
  )?.label;
  const transcribesOn =
    route.kind === "local"
      ? "Transcribes on this device"
      : environmentLabel
        ? `Transcribes on ${environmentLabel}`
        : null;
  const props = {
    isStarting: controller.isVoiceStarting,
    isWaitingForAudio: controller.isVoiceWaitingForAudio,
    isTranscribing: controller.isVoiceTranscribing,
    durationLabel: controller.voiceRecordingDurationLabel,
    waveformLevels: controller.voiceWaveformLevels,
    streamingPreviewText: controller.streamingPreviewText,
    disabled,
    onCancel: controller.cancel,
    onConfirm: () => {
      void controller.confirm();
    },
    onSend: () => {
      void controller.send();
    },
  };
  const onCancel = props.onCancel;
  // oxlint-disable-next-line goat/react-effect-budget -- Escape cancels the active recorder even when focus remains in the editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);
  const busy = props.isStarting || props.isTranscribing;
  const status = props.isTranscribing
    ? "Transcribing…"
    : props.isStarting || props.isWaitingForAudio
      ? "Preparing microphone…"
      : `Listening live · ${props.durationLabel}`;
  return (
    <div data-composer-voice-recorder="true" className="flex min-w-0 flex-1 flex-col gap-2 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <span
          role="status"
          className="shrink-0 rounded-full bg-accent px-2 py-1 text-xs tabular-nums text-muted-foreground"
        >
          {status}
        </span>
        {transcribesOn ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{transcribesOn}</span>
        ) : null}
        <div
          aria-hidden="true"
          className="flex h-7 min-w-0 flex-1 items-center justify-end gap-0.5 overflow-hidden motion-reduce:transition-none"
        >
          {props.waveformLevels.slice(-MAX_WAVEFORM_SAMPLES).map((level, index) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- Fixed waveform slots have positional identity.
              key={index}
              className="w-0.5 shrink-0 rounded-full bg-primary"
              style={{ height: `${3 + Math.min(1, Math.max(0, level)) * 21}px` }}
            />
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel voice recording (Escape)"
                onPointerDown={(event) => event.preventDefault()}
                onClick={onCancel}
              />
            }
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>Cancel (Esc)</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Confirm voice text"
                disabled={busy || props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onConfirm}
              />
            }
          >
            <CheckIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>Insert voice text</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-composer-send text-message-action-foreground disabled:opacity-50"
                aria-label="Send voice message"
                disabled={busy || props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onSend}
              />
            }
          >
            <ArrowUpIcon className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>Transcribe and send</TooltipPopup>
        </Tooltip>
      </div>
      {props.streamingPreviewText ? (
        <p
          aria-live="polite"
          aria-atomic="true"
          className="line-clamp-2 min-w-0 text-sm text-muted-foreground"
        >
          {props.streamingPreviewText}
        </p>
      ) : null}
    </div>
  );
}
