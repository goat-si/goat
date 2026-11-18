/** A run's user text and the run ordinal that decided which GOAT instructions wrapped it. */
export interface CursorRunPrompt {
  readonly text: string;
  readonly runOrdinal: number;
}

/**
 * Cursor drops a cancelled run from the conversation, so the next run carries its request and,
 * through its run ordinal, the GOAT instructions that only the cancelled run had.
 */
export function cursorRunPrompt(
  text: string,
  runOrdinal: number,
  interrupted: CursorRunPrompt | undefined,
): CursorRunPrompt {
  if (interrupted === undefined) return { text, runOrdinal };
  return {
    text: `Your previous turn was interrupted and is missing from your history. Some of its work may already be done. Its request was:\n\n${interrupted.text}\n\nThe new message, which may continue or change that request:\n\n${text}`,
    runOrdinal: interrupted.runOrdinal,
  };
}
