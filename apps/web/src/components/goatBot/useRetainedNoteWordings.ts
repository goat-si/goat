import type { BotId, EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { useServerConfigs } from "~/state/entities";
import type { NoteWordings } from "./GoatBotMemory";

/** Note edits the chat keeps while the work panel is closed, cleared when their owner changes. */
export function useRetainedNoteWordings(
  environmentId: EnvironmentId | null,
  botId: BotId | null,
  notesEnvironmentId: EnvironmentId | null,
): NoteWordings {
  const wordings = useState<ReadonlyMap<string, string>>(() => new Map());
  const configs = useServerConfigs();
  const capabilities =
    notesEnvironmentId === null
      ? undefined
      : configs.get(notesEnvironmentId)?.environment.capabilities;
  // A reconnect hides the capabilities for a moment; only a known mode change clears drafts.
  const [scopedNotes, setScopedNotes] = useState(capabilities?.goatBotPrivateNotes === true);
  if (capabilities !== undefined && (capabilities.goatBotPrivateNotes === true) !== scopedNotes) {
    setScopedNotes(capabilities.goatBotPrivateNotes === true);
  }
  const owner = JSON.stringify([environmentId, botId, scopedNotes]);
  const [previousOwner, setPreviousOwner] = useState(owner);
  if (previousOwner !== owner) {
    setPreviousOwner(owner);
    wordings[1](new Map());
  }
  return wordings;
}
