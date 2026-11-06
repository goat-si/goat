import { expect, it } from "vite-plus/test";
import type { AnnotationVoiceState } from "@goat/contracts";
import {
  annotationVoiceDraftMatches,
  makeAnnotationVoiceOrdering,
} from "./AnnotationVoiceOrdering.ts";

it("discards late state and preserves edits made before transcript insertion", () => {
  const order = makeAnnotationVoiceOrdering();
  const base: AnnotationVoiceState = {
    tabId: "tab",
    sessionId: "pick",
    sequence: 3,
    phase: "idle",
    available: true,
    destination: "Selected environment",
    error: null,
    draft: null,
  };
  const draft = {
    text: "new",
    cursor: 3,
    selectionEnd: 3,
    expectedText: "old",
    expectedCursor: 0,
    expectedSelectionEnd: 3,
  };
  expect(order(base)).toEqual({ applyState: true, applyDraft: false });
  expect(order({ ...base, sequence: 2, phase: "transcribing", draft })).toEqual({
    applyState: false,
    applyDraft: false,
  });
  expect(order({ ...base, sequence: 2, draft })).toEqual({ applyState: false, applyDraft: false });
  expect(annotationVoiceDraftMatches({ text: "old", cursor: 0, selectionEnd: 3 }, draft)).toBe(
    true,
  );
  expect(annotationVoiceDraftMatches({ text: "edited", cursor: 0, selectionEnd: 3 }, draft)).toBe(
    false,
  );
  expect(annotationVoiceDraftMatches({ text: "old", cursor: 1, selectionEnd: 3 }, draft)).toBe(
    false,
  );
});
