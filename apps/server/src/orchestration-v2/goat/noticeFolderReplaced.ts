import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as TerminalManager from "../../terminal/Manager.ts";

/**
 * Tells the live terminals inside a folder GOAT just recreated or set aside that their shell still
 * works in the old directory (goat#3690). Harnesses without a terminal manager have no terminals.
 */
export const makeNoticeFolderReplaced = Effect.map(
  Effect.serviceOption(TerminalManager.TerminalManager),
  (terminals) => (folder: string, setAsidePath?: string | null) =>
    Option.isSome(terminals)
      ? terminals.value.noticeFolderReplaced(folder, setAsidePath)
      : Effect.void,
);
