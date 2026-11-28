/**
 * Standing instructions travel inside the first message of a launched thread,
 * so the agent reads them on every provider and the transcript records exactly
 * what was injected. Clients split the block back out and show it collapsed.
 */

const OPENING = /^<standing_instructions version="([0-9a-f]{8})">\n/;
const CLOSING = "\n</standing_instructions>";

export interface StandingInstructionsBlock {
  readonly text: string;
  /** Short hash of the text, so a thread records which instructions it ran under. */
  readonly version: string;
}

/** FNV-1a over UTF-16 code units: stable everywhere, no crypto dependency. */
export function standingInstructionsVersion(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The message with the instructions block in front; unchanged when there are none. */
export function prependStandingInstructions(
  instructions: string,
  message: string,
): { readonly text: string; readonly block: StandingInstructionsBlock | null } {
  const text = instructions.trim();
  if (text.length === 0) return { text: message, block: null };
  const version = standingInstructionsVersion(text);
  const body = message.length === 0 ? "" : `\n\n${message}`;
  return {
    text: `<standing_instructions version="${version}">\n${text}\n</standing_instructions>${body}`,
    block: { text, version },
  };
}

/** Split a leading instructions block from a message, as prependStandingInstructions wrote it. */
export function splitStandingInstructions(message: string): {
  readonly block: StandingInstructionsBlock | null;
  readonly text: string;
} {
  const opening = OPENING.exec(message);
  if (opening === null) return { block: null, text: message };
  const version = opening[1]!;
  // The instructions may themselves contain the closing tag; the version hash
  // picks the one that ends the block.
  let close = message.indexOf(CLOSING, opening[0].length);
  while (close !== -1) {
    const text = message.slice(opening[0].length, close);
    const rest = message.slice(close + CLOSING.length);
    if (standingInstructionsVersion(text) === version && (rest === "" || rest.startsWith("\n\n"))) {
      return { block: { text, version }, text: rest.slice(2) };
    }
    close = message.indexOf(CLOSING, close + 1);
  }
  return { block: null, text: message };
}
