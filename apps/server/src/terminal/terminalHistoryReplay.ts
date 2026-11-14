import { BoundedTerminalHistory } from "./BoundedTerminalHistory.ts";

// Pop beyond Ghostty's eight-entry Kitty stacks on both screens before clearing
// flags. A 1049 round trip preserves the main cursor, text, and scrollback.
const INHERITED_INPUT_RESET =
  "\u001b[?1049h\u001b[<100u\u001b[=0;1u\u001b[?1049l" +
  "\u001b[?1;9;66;67;1000;1002;1003;1004;1005;1006;1015;2004l" +
  "\u001b[?25;1035;1036h\u001b[<100u\u001b[=0;1u\u001b[>4m";

export function neutralizeInheritedHistory(
  history: string,
  maxLines: number,
  maxBytes: number,
): string {
  // Scan exactly the cold replay window, reserving the entire longest reset so
  // neither the server nor the client can trim away the entry after we choose its exit.
  const resetBytes = history.includes("\u001b")
    ? Buffer.byteLength(INHERITED_INPUT_RESET + "\u001b7\u001b[?1049l")
    : 0;
  history = new BoundedTerminalHistory(
    // The suffix occupies the empty line after a trailing newline, too.
    resetBytes > 0 && history.endsWith("\n") ? maxLines - 1 : maxLines,
    history,
    Math.max(0, maxBytes - resetBytes),
  ).value();
  if (!history.includes("\u001b")) return history;
  // An unconditional 1049 reset restores a stale saved cursor on the main
  // screen. The exit must match the inherited screen's cursor-save behavior.
  let alternateScreen: number | undefined;
  for (const match of history.matchAll(/\u001b(?:\[\?([0-9;]+)([hl])|(c))/gu)) {
    if (match[3]) alternateScreen = undefined;
    for (const parameter of (match[1] ?? "").split(";")) {
      const mode = Number(parameter);
      if (mode === 47 || mode === 1047 || mode === 1049) {
        alternateScreen = match[2] === "h" ? (alternateScreen ?? mode) : undefined;
      }
    }
  }
  // A client may trim away the entry, leaving us on main: save its current
  // cursor before exiting. On alternate this saves only the alternate cursor.
  const leaveAlternateScreen =
    alternateScreen === undefined ? "" : `\u001b7\u001b[?${alternateScreen}l`;
  return history + leaveAlternateScreen + INHERITED_INPUT_RESET;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

// CAN and SUB abort any control sequence in progress.
function isControlSequenceCancel(codePoint: number): boolean {
  return codePoint === 0x18 || codePoint === 0x1a;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>=0-9;?]*$/.test(body)) {
    return true;
  }
  // Strip DECRQM/DECRPM query traffic to prevent echoed replies during replay; $ guards preserve setters.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// Strip DECRQSS/XTGETTCAP query traffic; replaying queries triggers fresh replies without visual value.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(
  input: string,
  start: number,
  belTerminates: boolean,
): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (
      (belTerminates && codePoint === 0x07) ||
      codePoint === 0x9c ||
      isControlSequenceCancel(codePoint)
    ) {
      return index + 1;
    }
    if (codePoint === 0x1b) {
      if (index + 1 >= input.length) return null;
      return input.charCodeAt(index + 1) === 0x5c ? index + 2 : index;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  if (input.charCodeAt(cursor) === 0x1b) return cursor;
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

const HISTORY_SEQUENCE_START = /\u001b/;
const NEXT_HISTORY_SEQUENCE_START = new RegExp(HISTORY_SEQUENCE_START.source, "g");

export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  if (pendingControlSequence.length === 0 && !HISTORY_SEQUENCE_START.test(data)) {
    return { visibleText: data, pendingControlSequence: "" };
  }

  const input = `${pendingControlSequence}${data}`;
  // Only the pending prefix's final ESC can begin a terminator split across chunks.
  const pendingScanStart = Math.max(0, pendingControlSequence.length - 1);
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        let body = "";
        let executedControls = "";
        while (cursor < input.length) {
          const cursorCodePoint = input.charCodeAt(cursor);
          const cancelled = isControlSequenceCancel(cursorCodePoint);
          if (cancelled || isCsiFinalByte(cursorCodePoint)) {
            if (cancelled || !shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(input.slice(index, cursor + 1));
            } else {
              append(executedControls);
            }
            index = cursor + 1;
            break;
          }
          if (cursorCodePoint < 0x10) executedControls += String.fromCharCode(cursorCodePoint);
          else if (
            (cursorCodePoint >= 0x20 || cursorCodePoint === 0x1b) &&
            cursorCodePoint !== 0x7f
          )
            body += String.fromCharCode(cursorCodePoint);
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(
          input,
          Math.max(index + 2, pendingScanStart),
          nextCodePoint === 0x5d,
        );
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      if (nextCodePoint !== 0x5a) append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    // One slice per printable run: every chunk of coloured output reaches this loop.
    NEXT_HISTORY_SEQUENCE_START.lastIndex = index + 1;
    const nextSequenceStart = NEXT_HISTORY_SEQUENCE_START.exec(input)?.index ?? input.length;
    append(input.slice(index, nextSequenceStart));
    index = nextSequenceStart;
  }

  return { visibleText, pendingControlSequence: "" };
}
