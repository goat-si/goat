"worklet";
// Runs on react-native-live-markdown's worklet runtime for every keystroke, over the whole note,
// and on Android on the UI thread. Everything is a top-level function with regex literals inside,
// so the worklet captures nothing it cannot copy. Ranges are emitted in order, containers before
// their contents, so no sort is needed; inline scanning stops at the line end and very long lines
// skip it, so a note costs one linear pass.

export type NoteMarkdownRangeType =
  | "bold"
  | "italic"
  | "strikethrough"
  | "link"
  | "code"
  | "pre"
  | "blockquote"
  | "h1"
  | "syntax";

export interface NoteMarkdownRange {
  type: NoteMarkdownRangeType;
  start: number;
  length: number;
  depth?: number;
}

const MAX_INLINE_LINE = 2000;

function push(
  ranges: NoteMarkdownRange[],
  type: NoteMarkdownRangeType,
  start: number,
  end: number,
  depth?: number,
) {
  if (end <= start) return;
  if (depth === undefined) ranges.push({ type, start, length: end - start });
  else ranges.push({ type, start, length: end - start, depth });
}

function isSpace(code: number) {
  return code === 32 || code === 9 || code === 10 || code === 13 || Number.isNaN(code);
}

function isAsciiPunctuation(code: number) {
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

/** Letters and digits, treating non-ASCII as letters apart from common spaces and punctuation. */
function isWordCode(code: number) {
  if (code < 128)
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return !(
    code === 0xa0 ||
    (code >= 0x2000 && code <= 0x206f) ||
    (code >= 0x3000 && code <= 0x3003) ||
    (code >= 0xff01 && code <= 0xff0f)
  );
}

function runLength(text: string, index: number, end: number, code: number) {
  let length = 0;
  while (index + length < end && text.charCodeAt(index + length) === code) length++;
  return length;
}

/** Index of the matching run of exactly `length` backticks, or -1. */
function closingBackticks(text: string, from: number, end: number, length: number) {
  let index = from;
  while (index < end) {
    if (text.charCodeAt(index) !== 96) {
      index++;
      continue;
    }
    const run = runLength(text, index, end, 96);
    if (run === length) return index;
    index += run;
  }
  return -1;
}

/** Whether `code` occurs in [from, end); indexOf would search past the line. */
function lineHas(text: string, from: number, end: number, code: number) {
  for (let index = from; index < end; index++) if (text.charCodeAt(index) === code) return true;
  return false;
}

/** Closing delimiter of `width` repeated `code` after non-space, skipping escapes and code. */
function closingDelimiter(text: string, from: number, end: number, code: number, width: number) {
  let index = from;
  while (index < end) {
    const current = text.charCodeAt(index);
    if (current === 92) {
      index += 2;
      continue;
    }
    if (current === 96) {
      const run = runLength(text, index, end, 96);
      const close = closingBackticks(text, index + run, end, run);
      index = close === -1 ? index + run : close + run;
      continue;
    }
    if (current === code) {
      const run = runLength(text, index, end, code);
      if (
        run >= width &&
        !isSpace(text.charCodeAt(index - 1)) &&
        (code !== 95 || !isWordCode(text.charCodeAt(index + run)))
      ) {
        // Prefer the delimiter at the end of a longer run, as in "**bold***".
        return index + run - width;
      }
      index += run;
      continue;
    }
    index++;
  }
  return -1;
}

/** Index of the bracket closing the one at `open`, honoring nesting and escapes, or -1. */
function closingBracket(text: string, open: number, end: number, opener: number, closer: number) {
  let depth = 0;
  for (let index = open; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code === 92) index++;
    else if (code === opener) depth++;
    else if (code === closer && --depth === 0) return index;
  }
  return -1;
}

// The characters that can start inline markdown; ":" finds bare URLs from their "://".
function isInlineTrigger(code: number) {
  return (
    code === 92 ||
    code === 124 ||
    code === 96 ||
    code === 60 ||
    code === 33 ||
    code === 91 ||
    code === 58 ||
    code === 42 ||
    code === 95 ||
    code === 126
  );
}

function isUrlTrailingPunctuation(code: number) {
  // . , ; : ! ? ' " ) ] * _ ~
  return (
    code === 46 ||
    code === 44 ||
    code === 59 ||
    code === 58 ||
    code === 33 ||
    code === 63 ||
    code === 39 ||
    code === 34 ||
    code === 41 ||
    code === 93 ||
    code === 42 ||
    code === 95 ||
    code === 126
  );
}

function parseInline(
  text: string,
  start: number,
  lineEnd: number,
  ranges: NoteMarkdownRange[],
  table: boolean,
  special: RegExp,
) {
  if (lineEnd - start > MAX_INLINE_LINE) return;
  // Open spans as [closer start, closer end] pairs, innermost last. Inner spans cannot cross the
  // closer of the span that contains them, and a closer's syntax is emitted when it is reached.
  const closers: number[] = [];
  let index = start;
  while (index < lineEnd || closers.length > 0) {
    if (closers.length > 0 && index >= closers[closers.length - 2]!) {
      push(ranges, "syntax", closers[closers.length - 2]!, closers[closers.length - 1]!);
      index = closers[closers.length - 1]!;
      closers.length -= 2;
      continue;
    }
    const end = closers.length > 0 ? closers[closers.length - 2]! : lineEnd;
    let code = text.charCodeAt(index);
    if (!isInlineTrigger(code)) {
      // Jump over plain text with the native regex search; a JS loop per character is slow on Hermes.
      special.lastIndex = index;
      const found = special.exec(text);
      index = found === null || found.index > end ? end : found.index;
      if (index >= end) {
        if (closers.length === 0) return;
        continue;
      }
      code = text.charCodeAt(index);
    }
    if (code === 92) {
      // A backslash escape dims the backslash and keeps the next character literal.
      if (index + 1 < end && isAsciiPunctuation(text.charCodeAt(index + 1))) {
        push(ranges, "syntax", index, index + 1);
        index += 2;
      } else index++;
      continue;
    }
    if (code === 124 && table) {
      push(ranges, "syntax", index, index + 1);
      index++;
      continue;
    }
    if (code === 96) {
      const run = runLength(text, index, end, 96);
      const close = closingBackticks(text, index + run, end, run);
      if (close === -1) {
        index += run;
        continue;
      }
      push(ranges, "syntax", index, index + run);
      push(ranges, "code", index + run, close);
      push(ranges, "syntax", close, close + run);
      index = close + run;
      continue;
    }
    if (code === 60) {
      const autolink = /^<(?:https?:\/\/|mailto:)[^\s<>]*>/i.exec(text.slice(index, end));
      if (autolink) {
        const close = index + autolink[0].length - 1;
        push(ranges, "syntax", index, index + 1);
        push(ranges, "link", index + 1, close);
        push(ranges, "syntax", close, close + 1);
        index = close + 1;
        continue;
      }
    }
    const image = code === 33 && text.charCodeAt(index + 1) === 91;
    if (code === 91 || image) {
      const open = image ? index + 1 : index;
      const close = closingBracket(text, open, end, 91, 93);
      if (close !== -1) {
        if (text.charCodeAt(open + 1) === 94) {
          push(ranges, "syntax", index, close + 1);
          index = close + 1;
          continue;
        }
        const next = text.charCodeAt(close + 1);
        const target =
          next === 40
            ? closingBracket(text, close + 1, end, 40, 41)
            : next === 91
              ? closingBracket(text, close + 1, end, 91, 93)
              : -1;
        if (target !== -1) {
          push(ranges, "syntax", index, open + 1);
          push(ranges, "link", open + 1, close);
          closers.push(close, target + 1);
          index = open + 1;
          continue;
        }
      }
    }
    if (code === 58 && text.startsWith("//", index + 1)) {
      const scheme = text.startsWith("https", index - 5)
        ? index - 5
        : text.startsWith("http", index - 4)
          ? index - 4
          : -1;
      if (scheme < start || isWordCode(text.charCodeAt(scheme - 1))) {
        index++;
        continue;
      }
      let urlEnd = index;
      while (urlEnd < end && !isSpace(text.charCodeAt(urlEnd)) && text.charCodeAt(urlEnd) !== 60)
        urlEnd++;
      while (urlEnd > index + 3 && isUrlTrailingPunctuation(text.charCodeAt(urlEnd - 1))) urlEnd--;
      push(ranges, "link", scheme, urlEnd);
      index = urlEnd;
      continue;
    }
    if (code === 42 || code === 95 || code === 126) {
      const run = runLength(text, index, end, code);
      const leftFlanking = !isSpace(text.charCodeAt(index + run));
      const intraword = code === 95 && isWordCode(text.charCodeAt(index - 1));
      if (!leftFlanking || intraword || (code === 126 && run !== 2)) {
        index += run;
        continue;
      }
      const width = code === 126 ? 2 : Math.min(run, 3);
      const inner = index + width;
      const close = closingDelimiter(text, inner, end, code, width);
      if (close === -1 || close === inner) {
        index += run;
        continue;
      }
      push(ranges, "syntax", index, inner);
      if (code === 126) push(ranges, "strikethrough", inner, close);
      else {
        if (width >= 2) push(ranges, "bold", inner, close);
        if (width !== 2) push(ranges, "italic", inner, close);
      }
      closers.push(close, close + width);
      index = inner;
      continue;
    }
    index++;
  }
}

function isTableDelimiterRow(line: string) {
  return (
    line.includes("-") &&
    /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?[ \t]*$/.test(line)
  );
}

/** Ranges for react-native-live-markdown: dimmed syntax plus styles over the raw text. */
export function parseNoteMarkdown(text: string): NoteMarkdownRange[] {
  const ranges: NoteMarkdownRange[] = [];
  const length = text.length;
  const special = /[\\|`<![:*_~]/g;
  let position = 0;
  let fenceCode = 0;
  let fenceLength = 0;
  let fenceBody = 0;
  let inTable = false;

  if (text.startsWith("---")) {
    const firstEnd = text.indexOf("\n");
    if (firstEnd !== -1 && /^---[ \t]*\r?$/.test(text.slice(0, firstEnd))) {
      const close = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(text.slice(firstEnd + 1));
      if (close) {
        const closeEnd = firstEnd + 1 + close.index + close[0].length;
        push(ranges, "syntax", 0, closeEnd);
        position = closeEnd + 1;
      }
    }
  }

  while (position <= length) {
    const newline = text.indexOf("\n", position);
    const lineEnd = newline === -1 ? length : newline;
    const end = lineEnd > position && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const next = newline === -1 ? length + 1 : newline + 1;

    let first = position;
    while (first < end && (text.charCodeAt(first) === 32 || text.charCodeAt(first) === 9)) first++;

    if (fenceCode !== 0) {
      if (text.charCodeAt(first) === fenceCode) {
        const close = /^(`{3,}|~{3,})[ \t]*$/.exec(text.slice(first, end));
        if (close && close[1]!.charCodeAt(0) === fenceCode && close[1]!.length >= fenceLength) {
          push(ranges, "pre", fenceBody, position > fenceBody ? position - 1 : position);
          push(ranges, "syntax", position, end);
          fenceCode = 0;
          position = next;
          continue;
        }
      }
      if (newline === -1) push(ranges, "pre", fenceBody, length);
      position = next;
      continue;
    }

    // Blockquote markers, possibly nested ("> > text" or ">>text"): count, then emit in order.
    let restStart = position;
    let depth = 0;
    for (;;) {
      let marker = restStart;
      while (marker < end && marker - restStart < 3 && text.charCodeAt(marker) === 32) marker++;
      if (text.charCodeAt(marker) !== 62 || marker >= end) break;
      restStart = marker + 1;
      if (
        restStart < end &&
        (text.charCodeAt(restStart) === 32 || text.charCodeAt(restStart) === 9)
      )
        restStart++;
      depth++;
    }
    if (depth > 0) {
      push(ranges, "blockquote", position, end, depth);
      for (let index = position; index < restStart; index++)
        if (text.charCodeAt(index) === 62) push(ranges, "syntax", index, index + 1);
      first = restStart;
      while (first < end && (text.charCodeAt(first) === 32 || text.charCodeAt(first) === 9))
        first++;
    }

    if (first >= end) {
      inTable = false;
      position = next;
      continue;
    }
    const lead = text.charCodeAt(first);
    const indent = first - restStart;

    if (lead === 96 || lead === 126) {
      const fence = /^(`{3,}|~{3,})(.*)$/.exec(text.slice(first, end));
      if (fence && !(lead === 96 && fence[2]!.includes("`"))) {
        push(ranges, "syntax", restStart, end);
        fenceCode = lead;
        fenceLength = fence[1]!.length;
        fenceBody = next;
        inTable = false;
        position = next;
        continue;
      }
    }

    if (lead === 35 && indent <= 3) {
      const hashes = runLength(text, first, end, 35);
      const after = first + hashes;
      if (
        hashes <= 6 &&
        (after === end || text.charCodeAt(after) === 32 || text.charCodeAt(after) === 9)
      ) {
        let contentStart = after;
        while (
          contentStart < end &&
          (text.charCodeAt(contentStart) === 32 || text.charCodeAt(contentStart) === 9)
        )
          contentStart++;
        let contentEnd = end;
        const closing = /[ \t]+#+[ \t]*$/.exec(text.slice(contentStart, end));
        if (closing) contentEnd = contentStart + closing.index;
        push(ranges, "syntax", restStart, contentStart);
        push(ranges, "h1", contentStart, contentEnd);
        parseInline(text, contentStart, contentEnd, ranges, false, special);
        push(ranges, "syntax", contentEnd, end);
        inTable = false;
        position = next;
        continue;
      }
    }

    if (
      (lead === 45 || lead === 42 || lead === 95) &&
      indent <= 3 &&
      /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text.slice(first, end))
    ) {
      push(ranges, "syntax", restStart, end);
      position = next;
      continue;
    }

    if (lead === 60 && text.startsWith("<!--", first)) {
      push(ranges, "syntax", restStart, end);
      position = next;
      continue;
    }

    if (lead === 91 && indent <= 3) {
      const definition = /^\[(\^?)[^\]]+\]:/.exec(text.slice(first, end));
      if (definition) {
        if (definition[1]) {
          push(ranges, "syntax", restStart, first + definition[0].length);
          parseInline(text, first + definition[0].length, end, ranges, false, special);
        } else push(ranges, "syntax", restStart, end);
        position = next;
        continue;
      }
    }

    if (inTable || (newline !== -1 && lineHas(text, first, end, 124))) {
      if (!inTable) {
        const followingEnd = text.indexOf("\n", next);
        const following = text.slice(next, followingEnd === -1 ? length : followingEnd);
        inTable = following.includes("|") && isTableDelimiterRow(following.replace(/\r$/, ""));
      }
      if (inTable) {
        if (isTableDelimiterRow(text.slice(restStart, end))) push(ranges, "syntax", restStart, end);
        else parseInline(text, restStart, end, ranges, true, special);
        position = next;
        continue;
      }
    }

    if (lead === 45 || lead === 43 || lead === 42 || (lead >= 48 && lead <= 57)) {
      const list = /^([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(text.slice(first, end));
      if (list) {
        push(ranges, "syntax", first, first + list[1]!.length);
        let contentStart = first + list[0].length;
        if (
          text.charCodeAt(contentStart) === 91 &&
          text.charCodeAt(contentStart + 2) === 93 &&
          /[ xX]/.test(text.charAt(contentStart + 1)) &&
          (contentStart + 3 === end ||
            text.charCodeAt(contentStart + 3) === 32 ||
            text.charCodeAt(contentStart + 3) === 9)
        ) {
          push(ranges, "syntax", contentStart, contentStart + 3);
          const checked = text.charCodeAt(contentStart + 1) !== 32;
          contentStart += 3;
          if (checked) push(ranges, "strikethrough", contentStart, end);
        }
        parseInline(text, contentStart, end, ranges, false, special);
        position = next;
        continue;
      }
    }

    parseInline(text, restStart, end, ranges, false, special);
    position = next;
  }

  return ranges;
}
