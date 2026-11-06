import {
  AuthOrchestrationOperateScope,
  type AnnotationVoiceEvent,
  type AnnotationVoiceState,
  type EnvironmentId,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { useLayoutEffect, useRef } from "react";
import { useComposerVoiceController } from "../chat/useComposerVoiceController";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useEnvironmentSpeechGrant } from "../../speech/voiceConsent";
import { previewBridge } from "./previewBridge";
import { toastManager } from "../ui/toast";

export function PreviewAnnotationSpeech({
  environmentId,
  tabId,
  sessionId,
}: {
  environmentId: EnvironmentId;
  tabId: string;
  sessionId: string;
}) {
  const grant = useEnvironmentSpeechGrant();
  const selected = grant?.environmentId === environmentId ? grant : null;
  const hasScope = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const connection = usePreparedConnection(environmentId);
  const proxied =
    Option.isSome(connection) && connection.value.target._tag === "HubProxyConnectionTarget";
  const available = selected !== null && hasScope && !proxied;
  const draft = useRef({ text: "", cursor: 0, selectionEnd: 0 });
  const pendingDraft = useRef<AnnotationVoiceState["draft"]>(null);
  const notifyDraft = useRef<(() => void) | null>(null);
  const announced = useRef(false);
  const sequence = useRef(0);
  const update = useStableCallback((state: Omit<AnnotationVoiceState, "sequence">) => {
    const bridge = previewBridge?.annotationVoice;
    if (bridge)
      void bridge
        .update({ ...state, sequence: ++sequence.current })
        .catch((error: unknown) => console.error("Annotation voice update failed", error));
  });
  const voice = useComposerVoiceController({
    environmentId,
    threadId: null,
    providerInstanceId: null,
    cwd: null,
    ownerKey: sessionId,
    locale: typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US",
    route: { kind: "environment", environmentId },
    localModelGrant: selected,
    enabled: available,
    readDraft: () => ({
      ownerKey: sessionId,
      text: draft.current.text,
      revision: 0,
      selection: { start: draft.current.cursor, end: draft.current.selectionEnd },
    }),
    subscribeDraft: (listener) => {
      notifyDraft.current = listener;
      return () => {
        if (notifyDraft.current === listener) notifyDraft.current = null;
      };
    },
    commitDraft: (text, selection) => {
      const expected = draft.current;
      if (text.length > 100_000) {
        toastManager.add({
          type: "error",
          title: "Transcription is too long for this annotation.",
        });
        return;
      }
      pendingDraft.current = {
        text,
        cursor: selection.start,
        selectionEnd: selection.end,
        expectedText: expected.text,
        expectedCursor: expected.cursor,
        expectedSelectionEnd: expected.selectionEnd,
      };
    },
  });
  const publish = useStableCallback(() =>
    update({
      tabId,
      sessionId,
      available,
      phase: voice.state.phase,
      error: voice.state.error?.slice(0, 2048) ?? null,
      draft: null,
    }),
  );
  const onEvent = useStableCallback((incomingTab: string, event: AnnotationVoiceEvent) => {
    if (incomingTab !== tabId || event.sessionId !== sessionId) return;
    draft.current = { text: event.text, cursor: event.cursor, selectionEnd: event.selectionEnd };
    notifyDraft.current?.();
    if (!announced.current) {
      announced.current = true;
      publish();
    }
    if (event.action === "start") void voice.start();
    else if (event.action === "stop") void voice.confirm();
    else if (event.action === "cancel") voice.cancel();
  });
  // oxlint-disable-next-line goat/react-effect-budget -- The guest's IPC listener belongs to this pick session.
  useLayoutEffect(() => previewBridge?.annotationVoice?.onEvent(onEvent), [onEvent]);
  // oxlint-disable-next-line goat/react-effect-budget -- Reflect recorder state in the isolated guest.
  useLayoutEffect(() => {
    if (announced.current) {
      const resultDraft = voice.state.phase === "idle" ? pendingDraft.current : null;
      if (resultDraft) pendingDraft.current = null;
      update({
        tabId,
        sessionId,
        available,
        phase: voice.state.phase,
        error: voice.state.error?.slice(0, 2048) ?? null,
        draft: resultDraft,
      });
    }
  }, [available, sessionId, tabId, voice.state.phase, voice.state.error, update]);
  return null;
}
