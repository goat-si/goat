import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AnnotationVoiceEvent,
  AnnotationVoicePickInput,
  AnnotationVoiceState,
} from "./previewAnnotationVoice.ts";
const decodeEvent = Schema.decodeUnknownSync(AnnotationVoiceEvent);
const decodePick = Schema.decodeUnknownSync(AnnotationVoicePickInput);
const decodeState = Schema.decodeUnknownSync(AnnotationVoiceState);
it("accepts old pick requests and bounds annotation voice messages", () => {
  expect(decodePick({ tabId: "tab" })).toEqual({ tabId: "tab" });
  expect(
    decodeEvent({
      sessionId: "session",
      action: "start",
      text: "draft",
      cursor: 2,
      selectionEnd: 3,
    }).action,
  ).toBe("start");
  expect(() =>
    decodeEvent({
      sessionId: "session",
      action: "start",
      text: "x".repeat(100_001),
      cursor: 0,
      selectionEnd: 0,
    }),
  ).toThrow();
  expect(() =>
    decodeState({
      tabId: "tab",
      sessionId: "session",
      phase: "idle",
      available: true,
      error: null,
      draft: { text: "", cursor: -1, selectionEnd: 0 },
    }),
  ).toThrow();
});
