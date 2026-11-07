import { ipcRenderer } from "electron";
import type {
  AnnotationVoiceConfig,
  AnnotationVoiceEvent,
  AnnotationVoiceState,
} from "@goat/contracts";
import { ANNOTATION_VOICE_EVENT_CHANNEL, ANNOTATION_VOICE_STATE_CHANNEL } from "./GuestProtocol.ts";
import {
  annotationVoiceDraftMatches,
  makeAnnotationVoiceOrdering,
} from "./AnnotationVoiceOrdering.ts";

export function installAnnotationVoice(input: {
  config: AnnotationVoiceConfig;
  comment: HTMLTextAreaElement;
  row: HTMLElement;
  resize: () => void;
}) {
  let active = true;
  let phase: AnnotationVoiceState["phase"] = "idle";
  let available = false;
  const order = makeAnnotationVoiceOrdering();
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Dictate";
  button.setAttribute("aria-label", "Start annotation dictation");
  button.className = "h-8 shrink-0 px-2 text-sm";
  button.hidden = true;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.setAttribute("aria-label", "Cancel annotation dictation");
  cancel.className = "h-8 shrink-0 px-2 text-sm";
  cancel.hidden = true;
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.className = "text-xs text-muted-foreground";
  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;min-width:0;align-items:center;gap:4px";
  status.style.cssText = "min-width:0;flex:1;overflow-wrap:anywhere";
  controls.append(button, cancel, status);
  input.row.append(controls);
  const busy = () => phase === "preparing" || phase === "recording" || phase === "transcribing";
  const send = (action: AnnotationVoiceEvent["action"]) => {
    if (!active) return;
    if (input.comment.value.length > 100_000) {
      if (busy())
        ipcRenderer.send(ANNOTATION_VOICE_EVENT_CHANNEL, {
          sessionId: input.config.sessionId,
          action: "cancel",
          text: "",
          cursor: 0,
          selectionEnd: 0,
        } satisfies AnnotationVoiceEvent);
      status.textContent = "Comment is too long for dictation.";
      return;
    }
    ipcRenderer.send(ANNOTATION_VOICE_EVENT_CHANNEL, {
      sessionId: input.config.sessionId,
      action,
      text: input.comment.value,
      cursor: input.comment.selectionStart,
      selectionEnd: input.comment.selectionEnd,
    } satisfies AnnotationVoiceEvent);
  };
  const sync = () => send("sync");
  const onButton = (event: MouseEvent) => {
    if (!event.isTrusted || !available) return;
    if (phase === "recording") send("stop");
    else if (!busy()) send("start");
  };
  const onCancel = (event: MouseEvent) => {
    if (event.isTrusted) send("cancel");
  };
  const preserveSelection = (event: PointerEvent) => event.preventDefault();
  button.addEventListener("pointerdown", preserveSelection);
  cancel.addEventListener("pointerdown", preserveSelection);
  button.addEventListener("click", onButton);
  cancel.addEventListener("click", onCancel);
  input.comment.addEventListener("input", sync);
  input.comment.addEventListener("select", sync);
  const onState = (_event: Electron.IpcRendererEvent, state: AnnotationVoiceState) => {
    if (!active || !state || state.sessionId !== input.config.sessionId) return;
    const { applyState, applyDraft } = order(state);
    if (applyState) {
      const wasBusy = busy();
      phase = state.phase;
      const isBusy = busy();
      if (isBusy !== wasBusy) {
        if (isBusy) {
          controls.style.width = "100%";
          input.row.after(controls);
        } else {
          controls.style.width = "";
          input.row.append(controls);
        }
        input.resize();
      }
      available = state.available;
      button.hidden = !available;
      button.disabled = phase === "preparing" || phase === "transcribing";
      button.textContent = phase === "recording" ? "Insert" : "Dictate";
      button.setAttribute(
        "aria-label",
        phase === "recording"
          ? "Insert annotation dictation"
          : `Start annotation dictation on ${state.destination ?? "the selected environment"}`,
      );
      button.title = `Transcribes on ${state.destination ?? "the selected environment"}`;
      cancel.hidden = !busy() && phase !== "error";
      status.textContent =
        state.error ??
        (phase === "preparing"
          ? "Preparing…"
          : phase === "recording"
            ? `Recording on ${state.destination ?? "the selected environment"}…`
            : phase === "transcribing"
              ? "Transcribing…"
              : "");
    }
    if (state.draft && applyDraft) {
      if (
        !annotationVoiceDraftMatches(
          {
            text: input.comment.value,
            cursor: input.comment.selectionStart,
            selectionEnd: input.comment.selectionEnd,
          },
          state.draft,
        )
      ) {
        status.textContent = "Comment changed; record again.";
        send("sync");
        return;
      }
      input.comment.value = state.draft.text;
      input.comment.setSelectionRange(state.draft.cursor, state.draft.selectionEnd);
      input.resize();
      input.comment.focus({ preventScroll: true });
      send("sync");
    }
  };
  ipcRenderer.on(ANNOTATION_VOICE_STATE_CHANNEL, onState);
  send("sync");
  return {
    busy,
    dispose() {
      active = false;
      ipcRenderer.off(ANNOTATION_VOICE_STATE_CHANNEL, onState);
      input.comment.removeEventListener("input", sync);
      input.comment.removeEventListener("select", sync);
      controls.remove();
    },
  };
}
