"worklet";
// Runs on react-native-live-markdown's worklet runtime for every keystroke, over the whole note.
// Everything is a top-level function with regex literals inside, so the worklet captures nothing
// it cannot copy. Inline scanning stops at the line end, and very long lines skip it, so a note
// costs one linear pass.

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

function isWordCharacter(text: string, index: number) {
  return index >= 0 && index < text.length && /[\p{L}\p{N}]/u.test(text.charAt(index));
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
    const found = text.indexOf("`", index);
    if (found === -1 || found >= end) return -1;
    const run = runLength(text, found, end, 96);
    if (run === length) return found;
    index = found + run;
  }
  return -1;
}

/** Closing delimiter `marker` that is preceded by non-space, skipping escapes and code spans. */
function closingDelimiter(text: string, from: number, end: number, marker: string) {
  const code = marker.charCodeAt(0);
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
        run >= marker.length &&
        !isSpace(text.charCodeAt(index - 1)) &&
        (code !== 95 || !isWordCharacter(text, index + run))
      ) {
        // Prefer the delimiter at the end of a longer run, as in "**bold***".
        return run === marker.length ? index : index + run - marker.length;
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

function parseInline(text: string, start: number, lineEnd: number, ranges: NoteMarkdownRange[]) {
  if (lineEnd - start > MAX_INLINE_LINE) return;
  // Pending closers of open spans, innermost last: reaching a closer jumps past it. Inner spans
  // cannot cross the closer of the span that contains them.
  const closers: number[] = [];
  let index = start;
  while (index < lineEnd) {
    if (closers.length > 0 && index >= closers[closers.length - 2]!) {
      index = closers[closers.length - 1]!;
      closers.length -= 2;
      continue;
    }
    const end = closers.length > 0 ? closers[closers.length - 2]! : lineEnd;
    const code = text.charCodeAt(index);
    if (code === 92) {
      // A backslash escape dims the backslash and keeps the next character literal.
      if (index + 1 < end && /[!-/:-@[-`{-~]/.test(text.charAt(index + 1))) {
        push(ranges, "syntax", index, index + 1);
        index += 2;
      } else index++;
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
        const footnote = text.charCodeAt(open + 1) === 94;
        const next = text.charCodeAt(close + 1);
        const target = footnote
          ? -1
          : next === 40
            ? closingBracket(text, close + 1, end, 40, 41)
            : next === 91
              ? closingBracket(text, close + 1, end, 91, 93)
              : -1;
        if (footnote) {
          push(ranges, "syntax", index, close + 1);
          index = close + 1;
          continue;
        }
        if (target !== -1) {
          push(ranges, "syntax", index, open + 1);
          push(ranges, "link", open + 1, close);
          push(ranges, "syntax", close, target + 1);
          closers.push(close, target + 1);
          index = open + 1;
          continue;
        }
      }
    }
    if (
      code === 104 &&
      !isWordCharacter(text, index - 1) &&
      (text.startsWith("https://", index) || text.startsWith("http://", index))
    ) {
      let urlEnd = index;
      while (urlEnd < end && !isSpace(text.charCodeAt(urlEnd)) && text.charCodeAt(urlEnd) !== 60)
        urlEnd++;
      while (urlEnd > index && /[.,;:!?'")\]*_~]/.test(text.charAt(urlEnd - 1))) urlEnd--;
      push(ranges, "link", index, urlEnd);
      index = urlEnd;
      continue;
    }
    if (code === 42 || code === 95 || code === 126) {
      const run = runLength(text, index, end, code);
      const leftFlanking = !isSpace(text.charCodeAt(index + run));
      const intraword = code === 95 && isWordCharacter(text, index - 1);
      if (!leftFlanking || intraword || (code === 126 && run !== 2)) {
        index += run;
        continue;
      }
      const width = code === 126 ? 2 : Math.min(run, 3);
      const marker = text.slice(index, index + width);
      const close = closingDelimiter(text, index + width, end, marker);
      if (close === -1 || close === index + width) {
        index += run;
        continue;
      }
      const inner = index + width;
      push(ranges, "syntax", index, inner);
      if (code === 126) push(ranges, "strikethrough", inner, close);
      else {
        if (width >= 2) push(ranges, "bold", inner, close);
        if (width !== 2) push(ranges, "italic", inner, close);
      }
      push(ranges, "syntax", close, close + width);
      closers.push(close, close + width);
      index = inner;
      continue;
    }
    index++;
  }
}

function isTableDelimiterRow(line: string) {
  return line.includes("|") || line.includes("-")
    ? /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?\|?[ \t]*$/.test(line) ||
        /^[ \t]*\|?[ \t]*:?-+:?[ \t]*\|[ \t]*$/.test(line)
    : false;
}

function parseTableRow(text: string, start: number, end: number, ranges: NoteMarkdownRange[]) {
  let inCode = 0;
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code === 92) index++;
    else if (code === 96) {
      const run = runLength(text, index, end, 96);
      inCode = inCode === run ? 0 : inCode === 0 ? run : inCode;
      index += run - 1;
    } else if (code === 124 && inCode === 0) push(ranges, "syntax", index, index + 1);
  }
  parseInline(text, start, end, ranges);
}

function lineContentEnd(text: string, lineEnd: number, lineStart: number) {
  return lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
}

/** Ranges for react-native-live-markdown: dimmed syntax plus styles over the raw text. */
export function parseNoteMarkdown(text: string): NoteMarkdownRange[] {
  const ranges: NoteMarkdownRange[] = [];
  const length = text.length;
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
    const end = lineContentEnd(text, lineEnd, position);
    const line = text.slice(position, end);
    const next = newline === -1 ? length + 1 : newline + 1;

    if (fenceCode !== 0) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]!.charCodeAt(0) === fenceCode && close[1]!.length >= fenceLength) {
        push(ranges, "pre", fenceBody, position > fenceBody ? position - 1 : position);
        push(ranges, "syntax", position, end);
        fenceCode = 0;
      } else if (newline === -1) push(ranges, "pre", fenceBody, length);
      position = next;
      continue;
    }

    // Blockquote markers, possibly nested ("> > text" or ">>text").
    let offset = 0;
    let depth = 0;
    const quote = /^ {0,3}>[ \t]?/;
    let match = quote.exec(line);
    while (match) {
      push(
        ranges,
        "syntax",
        position + offset + match[0].indexOf(">"),
        position + offset + match[0].indexOf(">") + 1,
      );
      offset += match[0].length;
      depth++;
      match = quote.exec(line.slice(offset));
    }
    if (depth > 0) push(ranges, "blockquote", position, end, depth);
    const rest = line.slice(offset);
    const restStart = position + offset;

    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(rest);
    if (fence && !(fence[1]!.charCodeAt(0) === 96 && fence[2]!.includes("`"))) {
      push(ranges, "syntax", restStart, end);
      fenceCode = fence[1]!.charCodeAt(0);
      fenceLength = fence[1]!.length;
      fenceBody = next;
      inTable = false;
      position = next;
      continue;
    }

    if (/^[ \t]*$/.test(rest)) {
      inTable = false;
      position = next;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(rest);
    if (heading) {
      const contentStart = restStart + heading[0].length;
      let contentEnd = end;
      const closing = /[ \t]+#+[ \t]*$/.exec(text.slice(contentStart, end));
      if (closing) contentEnd = contentStart + closing.index;
      push(ranges, "syntax", restStart, contentStart);
      push(ranges, "h1", contentStart, contentEnd);
      parseInline(text, contentStart, contentEnd, ranges);
      push(ranges, "syntax", contentEnd, end);
      inTable = false;
      position = next;
      continue;
    }

    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) {
      push(ranges, "syntax", restStart, end);
      position = next;
      continue;
    }

    if (/^ {0,3}<!--/.test(rest)) {
      push(ranges, "syntax", restStart, end);
      position = next;
      continue;
    }

    const definition = /^ {0,3}\[(\^?)[^\]]+\]:/.exec(rest);
    if (definition) {
      if (definition[1]) {
        push(ranges, "syntax", restStart, restStart + definition[0].length);
        parseInline(text, restStart + definition[0].length, end, ranges);
      } else push(ranges, "syntax", restStart, end);
      position = next;
      continue;
    }

    if (inTable || (rest.includes("|") && newline !== -1)) {
      if (!inTable) {
        const followingEnd = text.indexOf("\n", next);
        const following = text.slice(next, followingEnd === -1 ? length : followingEnd);
        inTable = isTableDelimiterRow(following.replace(/\r$/, ""));
      }
      if (inTable) {
        if (isTableDelimiterRow(rest)) push(ranges, "syntax", restStart, end);
        else parseTableRow(text, restStart, end, ranges);
        position = next;
        continue;
      }
    }

    const list = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(rest);
    if (list) {
      const markerStart = restStart + list[1]!.length;
      const markerEnd = markerStart + list[2]!.length;
      push(ranges, "syntax", markerStart, markerEnd);
      let contentStart = restStart + list[0].length;
      const task = /^\[([ xX])\](?=[ \t]|$)/.exec(text.slice(contentStart, end));
      if (task) {
        push(ranges, "syntax", contentStart, contentStart + 3);
        contentStart += 3;
        if (task[1] !== " ") push(ranges, "strikethrough", contentStart, end);
      }
      parseInline(text, contentStart, end, ranges);
      position = next;
      continue;
    }

    parseInline(text, restStart, end, ranges);
    position = next;
  }

  // Containers first at equal starts so inner styles layer on top of them natively.
  return ranges.sort((a, b) => a.start - b.start || b.length - a.length);
}
