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
  const state = {
    tabId: "tab",
    sessionId: "session",
    sequence: 1,
    phase: "idle",
    available: true,
    error: null,
    draft: {
      text: "done",
      cursor: 4,
      selectionEnd: 4,
      expectedText: "draft",
      expectedCursor: 0,
      expectedSelectionEnd: 5,
    },
  };
  expect(decodeState(state).draft?.text).toBe("done");
  expect(() =>
    decodeState({ ...state, draft: { ...state.draft, expectedSelectionEnd: 6 } }),
  ).toThrow();
});
