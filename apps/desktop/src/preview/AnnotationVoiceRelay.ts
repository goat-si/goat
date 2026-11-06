import {
  AnnotationVoiceEvent,
  type AnnotationVoiceConfig,
  type AnnotationVoiceState,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ANNOTATION_VOICE_EVENT_CHANNEL, ANNOTATION_VOICE_STATE_CHANNEL } from "./GuestProtocol.ts";

const decode = Schema.decodeUnknownOption(AnnotationVoiceEvent);

export function makeAnnotationVoiceRelay(input: {
  guest: Pick<Electron.WebContents, "ipc" | "send" | "isDestroyed">;
  voice: AnnotationVoiceConfig;
  forward: (event: AnnotationVoiceEvent) => void;
}) {
  let active = false;
  const onEvent = (_event: Electron.IpcMainEvent, value: unknown) => {
    if (!active) return;
    const decoded = decode(value);
    if (Option.isSome(decoded) && decoded.value.sessionId === input.voice.sessionId)
      input.forward(decoded.value);
  };
  return {
    register() {
      active = true;
      input.guest.ipc.on(ANNOTATION_VOICE_EVENT_CHANNEL, onEvent);
    },
    deactivate() {
      active = false;
    },
    dispose() {
      active = false;
      input.guest.ipc.removeListener(ANNOTATION_VOICE_EVENT_CHANNEL, onEvent);
    },
    update(state: AnnotationVoiceState) {
      if (active && state.sessionId === input.voice.sessionId && !input.guest.isDestroyed())
        input.guest.send(ANNOTATION_VOICE_STATE_CHANNEL, state);
    },
  };
}
