/**
 * Splits long outgoing text into Slack-sized messages without losing content.
 *
 * Ported from cli-jaw's shared splitter (src/messaging/chunk.ts,
 * https://github.com/cosmosjeon/cli-jaw, MIT, Copyright (c) 2026 CLI-Jaw Contributors).
 *
 * Guarantees, in order: chunks concatenate back to the input apart from the fence markers
 * added to keep a split code block closed; a cut never separates a surrogate pair; every chunk
 * that holds part of a code block opens and closes it, so the rest does not render as prose.
 * Only top-level fences are tracked: a fence inside a quote or list item splits as prose.
 *
 * @module slackMessageChunking
 */

/** Below this, fence-aware wrapping cannot fit; split plainly. */
const MIN_FENCE_AWARE_LIMIT = 24;
/** A longer info string is not a language; bounding it bounds the reserve. */
const MAX_FENCE_LANG = 20;

interface OpenFence {
  readonly marker: string;
  readonly lang: string;
}

/** A fence is a line construct: up to three spaces, then three or more backticks or tildes. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/;
const FENCE_ANYWHERE = /^ {0,3}(?:`{3,}|~{3,})/m;
const BARE_OPENER = /^ {0,3}(?:`{3,}|~{3,})[A-Za-z0-9_+#.-]*\n$/;
const LINE_START_FENCE = /^ {0,3}(?:`{3,}|~{3,})/;

/** What reopening and closing a fence costs; a language tag makes it longer. */
const fenceReserve = (lang: string, marker = "```") =>
  (marker + lang + "\n").length + ("\n" + marker).length;

const fenceLangOf = (info: string) =>
  /^[A-Za-z0-9_+#.-]*$/.test(info) ? info.slice(0, MAX_FENCE_LANG) : "";

/**
 * The fence still open after text. A closer uses the same character, is at least as long as its
 * opener and has no info string. atLineStart is false when text continues a line, so a delimiter
 * that sits mid-line in the source does not become a fence because a slice begins there.
 */
function scanOpenFence(
  text: string,
  initial: OpenFence | null,
  atLineStart: boolean,
): OpenFence | null {
  let open = initial;
  for (const [index, line] of text.split("\n").entries()) {
    if (index === 0 && !atLineStart) continue;
    const match = FENCE_LINE.exec(line);
    if (match === null) continue;
    const marker = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    if (open !== null) {
      if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info === "") {
        open = null;
      }
      continue;
    }
    open = { marker, lang: fenceLangOf(info) };
  }
  return open;
}

/** The widest opener in text, so every piece reserves room for its own reopener and closer. */
function widestFenceOpener(text: string): OpenFence {
  let widest: OpenFence = { marker: "```", lang: "" };
  let open: OpenFence | null = null;
  for (const line of text.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (match === null) continue;
    const marker = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    if (open !== null) {
      if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info === "") {
        open = null;
      }
      continue;
    }
    open = { marker, lang: fenceLangOf(info) };
    if (fenceReserve(open.lang, marker) > fenceReserve(widest.lang, widest.marker)) widest = open;
  }
  return widest;
}

/**
 * Moves a cut that would split a surrogate pair. When backing off would leave an empty chunk it
 * advances instead: a slightly long chunk beats half an emoji or a cut that never consumes input.
 */
function safeCut(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  if (code < 0xdc00 || code > 0xdfff) return index;
  return index > 1 ? index - 1 : index + 1;
}

/** Splits at newlines where it can; the newline stays with the chunk before it. */
function splitPreservingContent(text: string, limit: number): Array<string> {
  const out: Array<string> = [];
  let rest = text;
  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit - 1);
    let cut = newline > 0 ? newline + 1 : safeCut(rest, limit);
    if (cut <= 0) cut = safeCut(rest, Math.max(1, Math.min(limit, rest.length)));
    if (cut <= 0) cut = Math.min(2, rest.length);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Pushes whatever overflows budget from index start onward into the following pieces. */
function spillForward(out: Array<string>, start: number, budget: number) {
  for (let index = start; index < out.length; index += 1) {
    const current = out[index] ?? "";
    if (current.length <= budget) break;
    const keep = safeCut(current, budget);
    out[index] = current.slice(0, keep);
    const spill = current.slice(keep);
    if (index + 1 < out.length) out[index + 1] = spill + (out[index + 1] ?? "");
    else out.push(spill);
  }
}

/**
 * A reopener ends with a newline, so a delimiter run that sat mid-line in the source would start
 * a line in the next chunk and close the block early. Move one code point back across the seam.
 */
function avoidMidLineDelimiterAtSeam(pieces: ReadonlyArray<string>, budget: number) {
  const out = [...pieces];
  for (let index = 1; index < out.length; index += 1) {
    const previous = out[index - 1] ?? "";
    const piece = out[index] ?? "";
    if (previous.endsWith("\n") || !LINE_START_FENCE.test(piece)) continue;
    const low = previous.charCodeAt(previous.length - 1);
    const step = low >= 0xdc00 && low <= 0xdfff && previous.length >= 2 ? 2 : 1;
    if (previous.length <= step) continue;
    out[index - 1] = previous.slice(0, previous.length - step);
    out[index] = previous.slice(previous.length - step) + piece;
    spillForward(out, index, budget);
  }
  return out;
}

/** A piece holding only an opening fence line would post an empty code block; fold it forward. */
function mergeBareOpenerPieces(pieces: ReadonlyArray<string>, budget: number) {
  const out = [...pieces];
  // Bounded: a spill can itself be a bare opener, and rewinding onto it could repeat forever.
  let merges = 0;
  for (let index = 0; index < out.length - 1; index += 1) {
    const piece = out[index] ?? "";
    if (!BARE_OPENER.test(piece)) continue;
    if (merges >= pieces.length) break;
    merges += 1;
    out[index + 1] = piece + (out[index + 1] ?? "");
    out.splice(index, 1);
    index -= 1;
    spillForward(out, Math.max(index + 1, 0), budget);
  }
  return out;
}

/** Closes a fence a piece leaves open and reopens it on the next, so each chunk renders alone. */
function closeAndReopen(
  pieces: ReadonlyArray<string>,
  keepLang: boolean,
  maxReserve: number,
): Array<string> {
  const budget = Math.max(...pieces.map((piece) => piece.length), 1);
  const merged = mergeBareOpenerPieces(avoidMidLineDelimiterAtSeam(pieces, budget), budget);
  // A delimiter run wider than the reserve cannot be reopened within the limit; its block is
  // not carried across chunks. Delivery beats formatting.
  const repairable = (fence: OpenFence | null): fence is OpenFence =>
    fence !== null && fenceReserve(fence.lang, fence.marker) <= maxReserve;
  const out: Array<string> = [];
  let open: OpenFence | null = null;
  let atLineStart = true;
  for (const piece of merged) {
    const inherited = open;
    const after = scanOpenFence(piece, inherited, inherited !== null ? true : atLineStart);
    let chunk = piece;
    if (repairable(inherited)) {
      chunk = inherited.marker + (keepLang ? inherited.lang : "") + "\n" + chunk;
    }
    if (repairable(after)) {
      chunk = chunk.endsWith("\n") ? chunk + after.marker : chunk + "\n" + after.marker;
    }
    out.push(chunk);
    open = repairable(after) ? after : null;
    atLineStart = piece.endsWith("\n");
  }
  return out;
}

/**
 * Splits text into chunks of at most limit characters, preferring line breaks and keeping code
 * blocks closed in every chunk.
 */
export function chunkFenceAware(text: string, limit: number): Array<string> {
  const cap = Math.max(1, Math.floor(limit));
  if (text.length <= cap) return [text];
  // Without a fence nothing can straddle a boundary, and reserving room for markers would only
  // cost an extra message.
  if (!FENCE_ANYWHERE.test(text) || cap < MIN_FENCE_AWARE_LIMIT) {
    return splitPreservingContent(text, cap);
  }
  const widest = widestFenceOpener(text);
  const reserve = fenceReserve(widest.lang, widest.marker);
  const usableReserve = reserve < cap ? reserve : fenceReserve("");
  const budget = Math.max(1, cap - usableReserve);

  // A piece of only fence markers and whitespace would post as an empty code block. Merge it
  // forward instead of dropping it, so the source's blank lines survive.
  const pieces: Array<string> = [];
  let carry = "";
  for (const piece of splitPreservingContent(text, budget)) {
    const candidate = carry + piece;
    if (candidate.length > budget) {
      if (carry.length > 0) pieces.push(carry);
      pieces.push(piece);
      carry = "";
      continue;
    }
    if (candidate.replaceAll("```", "").trim() === "") {
      carry = candidate;
      continue;
    }
    pieces.push(candidate);
    carry = "";
  }
  if (carry.length > 0) {
    const last = pieces.at(-1);
    if (last !== undefined && last.length + carry.length <= budget) {
      pieces[pieces.length - 1] = last + carry;
    } else {
      pieces.push(carry);
    }
  }
  const out = closeAndReopen(pieces, reserve < cap, usableReserve);
  return out.length > 0 ? out : [text];
}
