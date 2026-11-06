import { AuthOrchestrationOperateScope, type EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { useId, type ReactNode, type RefObject } from "react";
import { useComposerVoiceController } from "../components/chat/useComposerVoiceController";
import { ComposerVoiceButton } from "../components/chat/ComposerVoiceButton";
import { Button } from "../components/ui/button";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { useEnvironment } from "../state/environments";
import { useEnvironmentSpeechGrant } from "./voiceConsent";

export function useCommentSpeech(input: {
  environmentId: EnvironmentId;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (text: string) => void;
  disabled?: boolean;
}) {
  const ownerKey = useId();
  const grant = useEnvironmentSpeechGrant();
  const selected = grant;
  const destinationId = selected?.environmentId ?? input.environmentId;
  const destinationLabel = useEnvironment(destinationId)?.label ?? "the selected environment";
  const hasScope = useEnvironmentScope(destinationId, AuthOrchestrationOperateScope);
  const connection = usePreparedConnection(destinationId);
  const proxied =
    Option.isSome(connection) && connection.value.target._tag === "HubProxyConnectionTarget";
  const voice = useComposerVoiceController({
    environmentId: input.environmentId,
    threadId: null,
    providerInstanceId: null,
    cwd: null,
    ownerKey,
    locale: typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US",
    route: { kind: "environment", environmentId: destinationId },
    localModelGrant: selected,
    enabled:
      selected !== null && hasScope && Option.isSome(connection) && !proxied && !input.disabled,
    readDraft: () => {
      const field = input.textareaRef.current;
      const text = field?.value ?? input.text;
      return {
        ownerKey,
        text,
        revision: 0,
        selection: {
          start: field?.selectionStart ?? text.length,
          end: field?.selectionEnd ?? text.length,
        },
      };
    },
    subscribeDraft: (listener) => {
      const field = input.textareaRef.current;
      field?.addEventListener("input", listener);
      return () => field?.removeEventListener("input", listener);
    },
    commitDraft: (text, selection) => {
      input.onTextChange(text);
      window.requestAnimationFrame(() => {
        const field = input.textareaRef.current;
        field?.focus({ preventScroll: true });
        field?.setSelectionRange(selection.start, selection.end);
      });
    },
  });
  return { voice, visible: selected !== null, destinationLabel };
}

export function CommentSpeechControls({ speech }: { speech: ReturnType<typeof useCommentSpeech> }) {
  if (!speech.visible) return null;
  const { voice } = speech;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sr-only">Transcribes on {speech.destinationLabel}</span>
      {voice.isVoiceActive ? (
        <>
          <span role="status">
            {voice.isVoiceTranscribing
              ? "Transcribing…"
              : voice.isVoiceStarting
                ? "Preparing…"
                : `Recording on ${speech.destinationLabel}…`}
          </span>
          <Button type="button" size="xs" variant="outline" onClick={voice.cancel}>
            Cancel recording
          </Button>
          {voice.isVoiceRecording ? (
            <Button type="button" size="xs" onClick={() => void voice.confirm()}>
              Insert voice text
            </Button>
          ) : null}
        </>
      ) : (
        <ComposerVoiceButton {...voice.voiceControl} />
      )}
      {voice.state.error ? <span role="alert">{voice.state.error}</span> : null}
    </span>
  );
}

export function CommentSpeechScope({
  children,
  ...input
}: Parameters<typeof useCommentSpeech>[0] & {
  children: (speech: ReturnType<typeof useCommentSpeech>) => ReactNode;
}) {
  return children(useCommentSpeech(input));
}
