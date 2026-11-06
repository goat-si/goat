// @effect-diagnostics nodeBuiltinImport:off - models Electron's guest IPC in a test.
import * as NodeEvents from "node:events";
import { expect, it, vi } from "vite-plus/test";
import { makeAnnotationVoiceRelay } from "./AnnotationVoiceRelay.ts";
import { ANNOTATION_VOICE_EVENT_CHANNEL, ANNOTATION_VOICE_STATE_CHANNEL } from "./GuestProtocol.ts";

it("forwards only valid events and states from the active annotation session", () => {
  const ipc = new NodeEvents.EventEmitter();
  const send = vi.fn();
  const forward = vi.fn();
  const guest = { ipc, send, isDestroyed: () => false } as unknown as Pick<
    Electron.WebContents,
    "ipc" | "send" | "isDestroyed"
  >;
  const relay = makeAnnotationVoiceRelay({ guest, voice: { sessionId: "current" }, forward });
  const event = {
    sessionId: "current",
    action: "start",
    text: "draft",
    cursor: 0,
    selectionEnd: 0,
  };
  relay.register();
  ipc.emit(ANNOTATION_VOICE_EVENT_CHANNEL, {}, { ...event, sessionId: "old" });
  ipc.emit(ANNOTATION_VOICE_EVENT_CHANNEL, {}, { ...event, text: "x".repeat(100_001) });
  ipc.emit(ANNOTATION_VOICE_EVENT_CHANNEL, {}, event);
  expect(forward).toHaveBeenCalledExactlyOnceWith(event);
  const state = {
    tabId: "tab",
    sessionId: "current",
    sequence: 1,
    phase: "idle" as const,
    available: true,
    error: null,
    draft: null,
  };
  relay.update({ ...state, sessionId: "old" });
  relay.update(state);
  expect(send).toHaveBeenCalledExactlyOnceWith(ANNOTATION_VOICE_STATE_CHANNEL, state);
  relay.deactivate();
  ipc.emit(ANNOTATION_VOICE_EVENT_CHANNEL, {}, event);
  expect(forward).toHaveBeenCalledOnce();
  relay.dispose();
  ipc.emit(ANNOTATION_VOICE_EVENT_CHANNEL, {}, event);
  relay.update(state);
  expect(forward).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
});
