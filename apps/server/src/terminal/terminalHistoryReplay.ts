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

interface C1Effect {
  /** ESC form of the sequence the code point starts, or "" when it returns to ground. */
  readonly next: string;
  /** Its 0x9A byte ran DECID, which replies with device attributes. */
  readonly query: boolean;
  /** What replays its visible effect from ground. */
  readonly safe: string;
}

// Outside ground and OSC, libghostty parses a code point's UTF-8 bytes one at a time: 0x80-0x9F
// act as C1 controls, the rest are dropped. Bytes left over after a return to ground print U+FFFD.
function c1Effect(codePoint: number): C1Effect | undefined {
  // A lone surrogate is encoded as U+FFFD, whose bytes are all dropped.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return undefined;
  let next: string | undefined;
  let query = false;
  let safe = "";
  for (let shift = codePoint > 0xffff ? 12 : codePoint > 0x7ff ? 6 : 0; shift >= 0; shift -= 6) {
    const byte = 0x80 | ((codePoint >> shift) & 0x3f);
    if (next === "") {
      safe += "\ufffd";
    } else if (next?.startsWith("\u001b]")) {
      next += "\ufffd";
    } else if (byte === 0x9b) {
      next = "\u001b[";
    } else if (byte === 0x9d) {
      next = "\u001b]";
    } else if (byte === 0x90) {
      next = "\u001bP";
    } else if (byte === 0x98 || byte === 0x9e || byte === 0x9f) {
      next = "\u001b_";
    } else if (byte < 0xa0) {
      next = "";
      query = byte === 0x9a;
      // Any other C1 control but ST runs as ESC plus the byte less 0x40.
      safe = query || byte === 0x9c ? "" : `\u001b${String.fromCharCode(byte - 0x40)}`;
    }
  }
  return next === undefined ? undefined : { next, query, safe };
}

// BEL ends only OSC; inside DCS, PM and APC it is payload. Non-ASCII is the reverse: libghostty
// keeps it inside OSC, while a C1 byte in it ends the other strings.
function findStringEnd(
  input: string,
  start: number,
  isOsc: boolean,
): { end: number; c1?: { effect: C1Effect; index: number } } | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if ((isOsc && codePoint === 0x07) || isControlSequenceCancel(codePoint)) {
      return { end: index + 1 };
    }
    // Like xterm.js, an ESC that does not start ST ends the string and begins the next sequence.
    if (codePoint === 0x1b) {
      if (index + 1 >= input.length) return null;
      return { end: input.charCodeAt(index + 1) === 0x5c ? index + 2 : index };
    }
    if (codePoint >= 0x80 && !isOsc) {
      const fullCodePoint = input.codePointAt(index) ?? codePoint;
      const end = index + (fullCodePoint > 0xffff ? 2 : 1);
      const effect = c1Effect(fullCodePoint);
      if (effect) return { end, c1: { effect, index } };
      index = end - 1;
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
  // A second ESC restarts the sequence, so leave it for the next pass.
  if (input.charCodeAt(cursor) === 0x1b) {
    return cursor;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

// libghostty prints UTF-8 C1 code points (U+0080-U+009F) as text, so only ESC starts a sequence.
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
  // Set when a C1 code point began the sequence at `index`: the ESC form that stands in for it.
  let c1Introducer = "";

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (c1Introducer.length > 0 || codePoint === 0x1b) {
      // Empty for a sequence the input introduces itself, which starts with ESC at `index`.
      const prefix = c1Introducer;
      c1Introducer = "";
      const contentStart = prefix.length > 0 ? index : index + 2;
      const nextCodePoint = (prefix || input).charCodeAt(prefix.length > 0 ? 1 : index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = contentStart;
        // Inside a CSI Ghostty executes 0x00-0x0F and ignores DEL and 0x10-0x1F, which it would
        // print in ground state. None join the parameters; only executed ones survive a strip.
        let body = "";
        let executedControls = "";
        while (cursor < input.length) {
          const cursorCodePoint = input.charCodeAt(cursor);
          const cancelled = isControlSequenceCancel(cursorCodePoint);
          if (cancelled || isCsiFinalByte(cursorCodePoint)) {
            if (cancelled || !shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(prefix + input.slice(index, cursor + 1));
            } else {
              append(executedControls);
            }
            index = cursor + 1;
            break;
          }
          if (cursorCodePoint >= 0x80) {
            const fullCodePoint = input.codePointAt(cursor) ?? cursorCodePoint;
            const end = cursor + (fullCodePoint > 0xffff ? 2 : 1);
            const c1 = c1Effect(fullCodePoint);
            if (c1) {
              // The CSI ends here undispatched, so it is kept only when the terminal is back in
              // ground with nothing to answer.
              if (c1.next.length === 0 && !c1.query) {
                append(prefix + input.slice(index, end));
              } else {
                append(executedControls + c1.safe);
              }
              c1Introducer = c1.next;
              index = end;
              break;
            }
            cursor = end;
            continue;
          }
          // An ESC abandons the CSI and starts the next sequence, which may be stripped.
          if (cursorCodePoint === 0x1b) {
            append(executedControls);
            index = cursor;
            break;
          }
          if (cursorCodePoint < 0x10) {
            executedControls += input[cursor];
          } else if (cursorCodePoint >= 0x20 && cursorCodePoint !== 0x7f) {
            body += input[cursor];
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: prefix + input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const stringEnd = findStringEnd(
          input,
          Math.max(contentStart, pendingScanStart),
          nextCodePoint === 0x5d,
        );
        if (stringEnd === null) {
          return { visibleText, pendingControlSequence: prefix + input.slice(index) };
        }
        const { end, c1 } = stringEnd;
        const content = stripStringTerminator(
          prefix.slice(2) + input.slice(contentStart, c1?.index ?? end),
        );
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (c1 === undefined || (!strip && c1.effect.next.length === 0 && !c1.effect.query)) {
          if (!strip) {
            append(prefix + input.slice(index, end));
          }
        } else {
          // ST stands in for a code point that cannot be replayed as it came.
          const closed = strip ? "" : `${prefix}${input.slice(index, c1.index)}\u009c`;
          append(closed + c1.effect.safe);
          c1Introducer = c1.effect.next;
        }
        index = end;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      // ESC Z (DECID) is the legacy primary device attributes query.
      if (nextCodePoint !== 0x5a) {
        append(input.slice(index, escapeSequenceEndIndex));
      }
      index = escapeSequenceEndIndex;
      continue;
    }

    // One slice per printable run: every chunk of coloured output reaches this loop.
    NEXT_HISTORY_SEQUENCE_START.lastIndex = index + 1;
    const nextSequenceStart = NEXT_HISTORY_SEQUENCE_START.exec(input)?.index ?? input.length;
    append(input.slice(index, nextSequenceStart));
    index = nextSequenceStart;
  }

  return { visibleText, pendingControlSequence: c1Introducer };
}
