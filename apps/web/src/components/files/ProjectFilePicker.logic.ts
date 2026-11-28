/*
 * Exact-path picker behavior adapted from Synara's WorkspaceSearchPalette.logic.ts.
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 * Copyright (c) 2026 Emanuele Di Pietro
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ProjectEntry } from "@goat/contracts";
import { splitFilePathPosition } from "@goat/shared/fileLinks";
import { workspaceRelativeFilePath } from "@goat/shared/path";
import { normalizeSearchQuery } from "@goat/shared/searchRanking";

export const PROJECT_FILE_PICKER_RESULT_LIMIT = 200;

export interface ProjectFilePickerMatch {
  readonly kind: ProjectEntry["kind"];
  readonly name: string;
  readonly nameMatchIndices: ReadonlyArray<number>;
  readonly path: string;
  readonly pathMatchIndices: ReadonlyArray<number>;
}

/** Only Windows destinations interpret a backslash as a path separator. */
export function projectFilePickerWorkspacePath(path: string, cwd: string, platform: string) {
  if (platform === "windows") return workspaceRelativeFilePath(path, cwd) ?? path;
  const root = cwd.replace(/\/+$/, "");
  if (path === cwd || path === root) return ".";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** Exact-path intent is interpreted for the destination environment, never the browser OS. */
export function isProjectFilePickerPathQuery(query: string, platform: string): boolean {
  const path = splitFilePathPosition(query.trim()).path;
  return platform === "windows"
    ? /^(?:[a-z]:[/\\]|\\\\[^\\/]+[/\\][^\\/]+|~[/\\])/i.test(path)
    : path.startsWith("/") || path.startsWith("~/");
}

/** The home comes from the destination's filesystem browse result, not its workspace path. */
export function resolveProjectFilePickerPath(query: string, platform: string, home: string | null) {
  if (!isProjectFilePickerPathQuery(query, platform)) return null;
  const position = splitFilePathPosition(query.trim());
  const windows = platform === "windows";
  const separator = windows ? "\\" : "/";
  const directoryOnly = (windows ? /[/\\]$/ : /\/$/).test(position.path);
  const homeRelative = position.path.startsWith("~");
  if (homeRelative && home === null) return null;
  const path = homeRelative ? `${home}${separator}${position.path.slice(2)}` : position.path;
  // Normalize before checking workspace containment, including /workspace/../outside.
  const root = windows
    ? (path.match(/^(?:[a-z]:[/\\]|\\\\[^\\/]+[/\\][^\\/]+[/\\]?)/i)?.[0] ?? "")
    : "/";
  const segments: string[] = [];
  for (const segment of path.slice(root.length).split(windows ? /[/\\]+/ : /\/+/)) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  const normalizedRoot = windows ? root.replaceAll("/", "\\").replace(/\\?$/, "\\") : root;
  return { ...position, path: normalizedRoot + segments.join(separator), directoryOnly };
}

/** Return null for unmatched subsequences; server-matched entries still render without highlights. */
function findMatchIndices(value: string, queryChars: ReadonlyArray<string>): number[] | null {
  if (queryChars.length === 0) return [];

  // Whole-string lowercasing preserves context-sensitive rules like Greek final sigma (Σ → ς);
  // lowercasing lengthens İ (to i̇) and shortens nothing, so only a length change needs mapping back.
  const normalizedValue = value.toLowerCase();
  const sourceSpans: Array<readonly [number, number]> = [];
  if (normalizedValue.length !== value.length) {
    let sourceOffset = 0;
    for (const char of value) {
      const span = [sourceOffset, sourceOffset + char.length] as const;
      for (let n = char.toLowerCase().length; n > 0; n -= 1) sourceSpans.push(span);
      sourceOffset = span[1];
    }
  }

  const indices: number[] = [];
  let queryIndex = 0;
  let offset = 0;

  for (const char of normalizedValue) {
    if (char === queryChars[queryIndex]) {
      const [start, end] = sourceSpans[offset] ?? [offset, offset + char.length];
      for (let i = Math.max(start, (indices.at(-1) ?? -1) + 1); i < end; i += 1) indices.push(i);
      queryIndex += 1;
      if (queryIndex === queryChars.length) return indices;
    }
    offset += char.length;
  }

  return null;
}

export function groupMatchRanges(
  indices: ReadonlyArray<number>,
): Array<readonly [start: number, end: number]> {
  const ranges: Array<[number, number]> = [];
  for (const index of indices) {
    const previous = ranges.at(-1);
    if (previous && previous[1] === index) {
      previous[1] = index + 1;
    } else {
      ranges.push([index, index + 1]);
    }
  }
  return ranges;
}

/** Preserve server ranking and query normalization while filtering files and computing highlights. */
export function getProjectFilePickerMatches(
  entries: ReadonlyArray<ProjectEntry>,
  rawQuery: string,
  limit = PROJECT_FILE_PICKER_RESULT_LIMIT,
): ProjectFilePickerMatch[] {
  if (limit <= 0) return [];

  const queryChars = Array.from(
    normalizeSearchQuery(rawQuery, {
      trimLeadingPattern: /^[@./]+/,
    }).replaceAll(/\s/g, ""),
  );
  const matches: ProjectFilePickerMatch[] = [];

  for (const entry of entries) {
    if (!rawQuery.trim() && entry.kind !== "file") continue;

    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const nameMatchIndices = findMatchIndices(name, queryChars);
    const pathMatchIndices = findMatchIndices(entry.path, queryChars);
    matches.push({
      kind: entry.kind,
      name,
      nameMatchIndices: nameMatchIndices ?? [],
      path: entry.path,
      pathMatchIndices: pathMatchIndices ?? [],
    });
    if (matches.length >= limit) break;
  }

  return matches;
}
