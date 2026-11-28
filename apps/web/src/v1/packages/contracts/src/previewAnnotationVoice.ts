import * as Schema from "effect/Schema";
import { DesktopPreviewTabIdSchema } from "./desktopBrowser.ts";

const SessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const Text = Schema.String.check(Schema.isMaxLength(100_000));
const Cursor = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100_000),
);
export const AnnotationVoiceConfig = Schema.Struct({ sessionId: SessionId });
export type AnnotationVoiceConfig = typeof AnnotationVoiceConfig.Type;
export const AnnotationVoiceEvent = Schema.Struct({
  sessionId: SessionId,
  action: Schema.Literals(["sync", "start", "stop", "cancel"]),
  text: Text,
  cursor: Cursor,
  selectionEnd: Cursor,
}).check(
  Schema.makeFilter(
    ({ text, cursor, selectionEnd }) => cursor <= selectionEnd && selectionEnd <= text.length,
  ),
);
export type AnnotationVoiceEvent = typeof AnnotationVoiceEvent.Type;
export const AnnotationVoiceState = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  sessionId: SessionId,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  phase: Schema.Literals(["idle", "preparing", "recording", "transcribing", "error"]),
  available: Schema.Boolean,
  destination: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
  draft: Schema.NullOr(
    Schema.Struct({
      text: Text,
      cursor: Cursor,
      selectionEnd: Cursor,
      expectedText: Text,
      expectedCursor: Cursor,
      expectedSelectionEnd: Cursor,
    }).check(
      Schema.makeFilter(
        ({ text, cursor, selectionEnd, expectedText, expectedCursor, expectedSelectionEnd }) =>
          cursor <= selectionEnd &&
          selectionEnd <= text.length &&
          expectedCursor <= expectedSelectionEnd &&
          expectedSelectionEnd <= expectedText.length,
      ),
    ),
  ),
});
export type AnnotationVoiceState = typeof AnnotationVoiceState.Type;
export const AnnotationVoicePickInput = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  voice: Schema.optionalKey(AnnotationVoiceConfig),
});

export interface AnnotationVoiceBridge {
  annotationVoice?: {
    onEvent: (listener: (tabId: string, event: AnnotationVoiceEvent) => void) => () => void;
    update: (state: AnnotationVoiceState) => Promise<void>;
  };
}
export type AnnotationVoicePick = (
  tabId: string,
  voice?: AnnotationVoiceConfig,
) => Promise<import("./ipc.ts").PreviewAnnotationSubmissionResult | null>;
