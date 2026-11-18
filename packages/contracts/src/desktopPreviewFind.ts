import * as Schema from "effect/Schema";

import { DesktopPreviewTabIdSchema } from "./desktopBrowser.ts";

export const DesktopPreviewFindInput = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  text: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  forward: Schema.Boolean,
  newSession: Schema.Boolean,
});

export interface DesktopPreviewFindResult {
  readonly tabId: string;
  readonly activeMatchOrdinal: number;
  readonly matches: number;
}

export interface DesktopPreviewFindBridge {
  findInPage?: (input: typeof DesktopPreviewFindInput.Type) => Promise<void>;
  stopFindInPage?: (tabId: string) => Promise<void>;
  onFindResult?: (listener: (event: DesktopPreviewFindResult) => void) => () => void;
}
