import type { ProjectSearchContentsInput, ProjectSearchContentsResult } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { isWholeWordRange, mapContentMatchRanges } from "./workspaceContentMatchRanges.ts";
import { makeIgnoreFileDecider } from "./workspaceIgnoreFiles.ts";

const MAX_GREP_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_GREP_TIMEOUT_MS = 30_000;
const MAX_MATCHES_PER_FILE = 100;
// FFF shows at most 512 characters of a matching line.
const CONTENT_LINE_MAX_LENGTH = 512;

type SearchInput = Omit<ProjectSearchContentsInput, "cwd">;
type RegexLineMatches = { readonly column: number; readonly texts: string[] };

// Git grep -z puts NUL between fields and a newline after the text. A path can contain a newline.
function* grepRecords(stdout: string, fieldCount: number) {
  let cursor = 0;
  while (cursor < stdout.length) {
    const fields: string[] = [];
    for (let index = 1; index < fieldCount; index += 1) {
      const end = stdout.indexOf("\0", cursor);
      if (end < 0) return;
      fields.push(stdout.slice(cursor, end));
      cursor = end + 1;
    }
    const end = stdout.indexOf("\n", cursor);
    if (end < 0) return;
    fields.push(stdout.slice(cursor, end));
    cursor = end + 1;
    yield fields;
  }
}

// Git before 2.55 may give the wrong column after a line's first match.
function locateRegexMatches(
  line: string,
  matches: RegexLineMatches | undefined,
): Array<readonly [number, number]> {
  if (!matches) return [];
  const bytes = Buffer.from(line);
  const ranges: Array<readonly [number, number]> = [];
  let start = matches.column - 1;
  for (const text of matches.texts) {
    const match = Buffer.from(text);
    const previous = ranges.at(-1);
    if (previous) start = bytes.indexOf(match, previous[1]);
    if (start < 0 || start + match.length > bytes.length) break;
    ranges.push([start, start + match.length]);
  }
  return ranges;
}

const runGitGrep = Effect.fn("WorkspaceSearchIndex.gitGrep")(function* (
  vcsProcess: VcsProcess.VcsProcess["Service"],
  cwd: string,
  input: SearchInput,
  regexMode: boolean,
  onlyMatching = false,
) {
  return yield* vcsProcess
    .run({
      operation: "WorkspaceSearchIndex.gitGrep",
      command: "git",
      args: [
        "-c",
        "core.fsmonitor=false",
        "grep",
        "--untracked",
        "--no-color",
        "--no-textconv",
        "--threads=2",
        "-I",
        "-n",
        "-z",
        "-m",
        String(MAX_MATCHES_PER_FILE),
        ...(onlyMatching ? ["-o", "--column"] : []),
        ...(input.caseSensitive ? [] : ["-i"]),
        regexMode ? "-P" : "-F",
        "-e",
        input.query,
        "--",
      ],
      cwd,
      allowNonZeroExit: true,
      timeoutMs: GIT_GREP_TIMEOUT_MS,
      maxOutputBytes: MAX_GREP_OUTPUT_BYTES,
      outputMode: "truncate",
      appendTruncationMarker: false,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
});

export const searchContentsWithGit = Effect.fn("WorkspaceSearchIndex.searchContentsWithGit")(
  function* (
    vcsProcess: VcsProcess.VcsProcess["Service"],
    cwd: string,
    input: SearchInput,
  ): Effect.fn.Return<ProjectSearchContentsResult | undefined> {
    if (input.query.includes("\n") || input.query.includes("\0")) return undefined;
    let regexMode = input.useRegex;
    let regexFallbackError: string | undefined;
    let result = yield* runGitGrep(vcsProcess, cwd, input, regexMode);
    if (
      regexMode &&
      result?.exitCode === 128 &&
      /^fatal: (?:-e option,|command line,|PCRE2 compilation failed)/i.test(result.stderr)
    ) {
      regexFallbackError = result.stderr.trim().split("\n")[0];
      regexMode = false;
      result = yield* runGitGrep(vcsProcess, cwd, input, regexMode);
    }
    if (!result || result.exitCode > 1 || result.stdoutInvalidUtf8) return undefined;

    const regexMatches = new Map<string, RegexLineMatches>();
    let rangesTruncated = false;
    if (regexMode && result.exitCode === 0) {
      // Do not evaluate a user-supplied regex in JS to get highlight ranges.
      const ranges = yield* runGitGrep(vcsProcess, cwd, input, true, true);
      if (!ranges || ranges.exitCode > 1 || ranges.stdoutInvalidUtf8) return undefined;
      rangesTruncated = ranges.stdoutTruncated;
      for (const [relativePath, lineNumber, column, text] of grepRecords(ranges.stdout, 4)) {
        const start = Number(column);
        if (
          !relativePath ||
          !lineNumber ||
          text === undefined ||
          !Number.isSafeInteger(start) ||
          start < 1
        )
          continue;
        const key = `${relativePath}\0${lineNumber}`;
        const existing = regexMatches.get(key);
        if (existing) existing.texts.push(text);
        else regexMatches.set(key, { column: start, texts: [text] });
      }
    }
    const literal = regexMode
      ? undefined
      : new RegExp(
          input.query.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"),
          input.caseSensitive ? "gu" : "giu",
        );
    const decide = makeIgnoreFileDecider(cwd);
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    let currentPath: string | undefined;
    let excluded = false;
    let rangesCutOff = false;
    for (const [relativePath, lineNumber, rawLine] of grepRecords(result.stdout, 3)) {
      const line = Number(lineNumber);
      if (!relativePath || rawLine === undefined || !Number.isSafeInteger(line) || line < 1)
        continue;
      if (relativePath !== currentPath) {
        currentPath = relativePath;
        excluded = false;
        const segments = relativePath.split("/");
        let path = "";
        for (const [index, segment] of segments.entries()) {
          path = index === 0 ? segment : `${path}/${segment}`;
          const decision = yield* decide(path, index < segments.length - 1);
          if (decision === "unavailable") return undefined;
          if (decision === "ignored") {
            excluded = true;
            break;
          }
        }
      }
      if (excluded) continue;
      const regexLine = regexMatches.get(`${relativePath}\0${lineNumber}`);
      if (rangesTruncated && !regexLine) {
        rangesCutOff = true;
        break;
      }
      const lineContent = (rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine).slice(
        0,
        CONTENT_LINE_MAX_LENGTH,
      );
      const matchRanges = (
        literal
          ? Array.from(lineContent.matchAll(literal), (match) => ({
              start: match.index,
              end: match.index + match[0].length,
            }))
          : mapContentMatchRanges(lineContent, locateRegexMatches(lineContent, regexLine))
      ).filter((range) => !input.wholeWord || isWholeWordRange(lineContent, range));
      if (input.wholeWord && matchRanges.length === 0) continue;
      matches.push({ path: relativePath, lineNumber: line, lineContent, matchRanges });
      if (matches.length > input.limit) break;
    }
    return {
      matches: matches.slice(0, input.limit),
      truncated:
        matches.length > input.limit || result.stdoutTruncated || rangesTruncated || rangesCutOff,
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  },
);
