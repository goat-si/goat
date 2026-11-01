import {
  ORCHESTRATION_V2_MAX_COMMAND_ACTIONS,
  OrchestrationV2CommandAction,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

/** Checks optional classification metadata before it can invalidate a provider event. */
export const isCommandActions = Schema.is(
  Schema.Array(OrchestrationV2CommandAction).check(
    Schema.isMaxLength(ORCHESTRATION_V2_MAX_COMMAND_ACTIONS),
  ),
);

/**
 * Conservative shell-command classifier for providers that only report the
 * raw command string. It recognizes commands that only read files, list
 * files, or search, and returns an empty list for anything else, so an
 * unrecognized or possibly mutating command keeps its terminal row.
 *
 * The rules follow Codex's own parser (codex-rs shell-command parse_command):
 * one unknown step makes the whole command unknown.
 */

const MAX_COMMAND_LENGTH = 4_096;
const SHELLS = new Set(["sh", "bash", "zsh"]);

type Token = { readonly kind: "word"; readonly value: string } | { readonly kind: "and" | "pipe" };

/** Splits a command into words and the two operators we accept, or null. */
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", value: word });
    word = "";
    inWord = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === " " || char === "\t") {
      flush();
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return null;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end;
      continue;
    }
    if (char === '"') {
      let closed = false;
      for (index += 1; index < command.length; index += 1) {
        const inner = command[index]!;
        if (inner === '"') {
          closed = true;
          break;
        }
        // Expansions inside double quotes depend on runtime state.
        if (inner === "$" || inner === "`") return null;
        if (inner === "\\" && index + 1 < command.length) {
          const next = command[index + 1]!;
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            word += next;
            index += 1;
            continue;
          }
        }
        word += inner;
      }
      if (!closed) return null;
      inWord = true;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= command.length) return null;
      word += command[index + 1]!;
      inWord = true;
      index += 1;
      continue;
    }
    if (char === "&") {
      if (command[index + 1] !== "&") return null;
      flush();
      tokens.push({ kind: "and" });
      index += 1;
      continue;
    }
    if (char === "|") {
      if (command[index + 1] === "|") return null;
      flush();
      tokens.push({ kind: "pipe" });
      continue;
    }
    if (char === ">") {
      // Allow only discarding stderr: `2>/dev/null`.
      const rest = command.slice(index);
      if (inWord && word === "2" && /^>\/dev\/null(?=[\s|&]|$)/u.test(rest)) {
        word = "";
        inWord = false;
        index += ">/dev/null".length - 1;
        continue;
      }
      return null;
    }
    if (char === "#" && !inWord) return null;
    if ("$`;<()\r\n".includes(char)) return null;
    word += char;
    inWord = true;
  }
  flush();
  return tokens;
}

interface Operands {
  readonly operands: string[];
  readonly flags: Map<string, string | true>;
}

/** Separates flags from operands; a listed flag consumes the next word as its value. */
function splitArgs(args: readonly string[], flagsWithValues: ReadonlySet<string>): Operands {
  const operands: string[] = [];
  const flags = new Map<string, string | true>();
  let flagsDone = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flagsDone || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
      continue;
    }
    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals > 0) {
      flags.set(arg.slice(0, equals), arg.slice(equals + 1));
      continue;
    }
    if (flagsWithValues.has(arg) && index + 1 < args.length) {
      flags.set(arg, args[index + 1]!);
      index += 1;
      continue;
    }
    flags.set(arg, true);
  }
  return { operands, flags };
}

function flagValue(flags: Operands["flags"], names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = flags.get(name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function hasFlag(flags: Operands["flags"], names: readonly string[]): boolean {
  return names.some((name) => flags.has(name));
}

function reads(paths: readonly string[]): OrchestrationV2CommandAction[] | null {
  if (paths.length === 0 || paths.some((path) => path === "-" || !path.trim())) return null;
  return paths.map((path) => ({ type: "read", path: path.trim() }));
}

function search(query: string | undefined, path: string | undefined) {
  return [
    {
      type: "search" as const,
      ...(query?.trim() ? { query: query.trim() } : {}),
      ...(path?.trim() ? { path: path.trim() } : {}),
    },
  ];
}

function list(paths: readonly string[]): OrchestrationV2CommandAction[] {
  if (paths.length === 0) return [{ type: "list" }];
  return paths.map((path) => ({ type: "list", path }));
}

const HEAD_TAIL_FLAGS = new Set(["-n", "-c", "--lines", "--bytes"]);
const BAT_FLAGS = new Set([
  "-r",
  "--line-range",
  "-l",
  "--language",
  "-H",
  "--highlight-line",
  "--style",
  "--theme",
  "--paging",
  "--color",
  "--tabs",
]);
const NL_FLAGS = new Set(["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"]);
const LS_FLAGS = new Set(["-I", "-w", "--ignore", "--hide", "--block-size", "--format", "--sort"]);
const TREE_FLAGS = new Set(["-L", "-P", "-I", "--charset", "--filelimit", "--sort"]);
const RG_FLAGS = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-g",
  "--glob",
  "--iglob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "--type-add",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-m",
  "--max-count",
  "-M",
  "--max-columns",
  "-d",
  "--max-depth",
  "--max-filesize",
  "-j",
  "--threads",
  "--sort",
  "--sortr",
  "--color",
  "--colors",
  "-E",
  "--encoding",
  "-r",
  "--replace",
  "--ignore-file",
  "--path-separator",
  "--context-separator",
  "--field-match-separator",
]);
const GREP_FLAGS = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-m",
  "--max-count",
  "-d",
  "--directories",
  "-D",
  "--devices",
  "--label",
]);
const FD_FLAGS = new Set([
  "-e",
  "--extension",
  "-t",
  "--type",
  "-d",
  "--max-depth",
  "--min-depth",
  "--exact-depth",
  "-E",
  "--exclude",
  "-j",
  "--threads",
  "-S",
  "--size",
  "--changed-within",
  "--changed-before",
  "-o",
  "--owner",
  "--base-directory",
  "--search-path",
  "--path-separator",
  "-c",
  "--color",
]);
const FIND_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
const FIND_NAME_TESTS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-regex",
  "-iregex",
]);
const SED_PRINT_SCRIPT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p(?:;(?:\d+|\$)(?:,(?:\d+|\$))?p)*;?$/u;

function grepLike(args: readonly string[], recursiveFlags: readonly string[] | null) {
  const { operands, flags } = splitArgs(args, GREP_FLAGS);
  const pattern = flagValue(flags, ["-e", "--regexp"]);
  const usesPatternFile = hasFlag(flags, ["-f", "--file"]);
  const query = pattern ?? (usesPatternFile ? undefined : operands[0]);
  const paths = pattern !== undefined || usesPatternFile ? operands : operands.slice(1);
  if (query === undefined && !usesPatternFile) return null;
  // Without a path, plain grep reads stdin; only a recursive search names the workspace.
  if (
    paths.length === 0 &&
    recursiveFlags !== null &&
    ![...flags.keys()].some(
      (flag) => recursiveFlags.includes(flag) || (/^-[A-Za-z]+$/u.test(flag) && /[rR]/u.test(flag)),
    )
  ) {
    return null;
  }
  return search(query, paths[0]);
}

/** Classifies one simple command (no operators), or returns null. */
function classifySimpleCommand(words: readonly string[]): OrchestrationV2CommandAction[] | null {
  const [program, ...args] = words;
  if (program === undefined) return null;
  switch (program) {
    case "cat": {
      const { operands, flags } = splitArgs(args, new Set());
      if ([...flags.keys()].some((flag) => !/^-[nbsvetAET]+$/u.test(flag))) return null;
      return reads(operands);
    }
    case "bat":
    case "batcat": {
      const { operands } = splitArgs(args, BAT_FLAGS);
      return reads(operands);
    }
    case "head":
    case "tail": {
      const { operands, flags } = splitArgs(args, HEAD_TAIL_FLAGS);
      const allowed = [...flags.keys()].every(
        (flag) =>
          HEAD_TAIL_FLAGS.has(flag) ||
          /^-\d+$/u.test(flag) ||
          /^-[nc]\+?\d+$/u.test(flag) ||
          flag === "-q" ||
          flag === "-v",
      );
      return allowed ? reads(operands.filter((operand) => !/^\+\d+$/u.test(operand))) : null;
    }
    case "sed": {
      // Only `sed -n '<range>p' file` prints; every other sed form may edit.
      const [flag, script, ...files] = args;
      if (flag !== "-n" || script === undefined || !SED_PRINT_SCRIPT.test(script)) return null;
      if (files.some((file) => file.startsWith("-"))) return null;
      return reads(files);
    }
    case "nl": {
      const { operands } = splitArgs(args, NL_FLAGS);
      return reads(operands);
    }
    case "ls":
    case "eza":
    case "exa": {
      const { operands } = splitArgs(args, LS_FLAGS);
      return list(operands);
    }
    case "tree": {
      const { operands, flags } = splitArgs(args, TREE_FLAGS);
      return [...flags.keys()].some((flag) => flag.startsWith("-o")) ? null : list(operands);
    }
    case "rg":
    case "ripgrep": {
      const { operands, flags } = splitArgs(args, RG_FLAGS);
      // --pre runs an arbitrary program on every file.
      if (hasFlag(flags, ["--pre", "--pre-glob"])) return null;
      if (flags.has("--files")) return list(operands);
      const pattern = flagValue(flags, ["-e", "--regexp"]);
      const usesPatternFile = hasFlag(flags, ["-f", "--file"]);
      const query = pattern ?? (usesPatternFile ? undefined : operands[0]);
      if (query === undefined && !usesPatternFile) return null;
      const paths = pattern !== undefined || usesPatternFile ? operands : operands.slice(1);
      return search(query, paths[0]);
    }
    case "grep":
    case "egrep":
    case "fgrep":
      return grepLike(args, ["--recursive", "--dereference-recursive"]);
    case "git": {
      const [subcommand, ...rest] = args;
      if (subcommand === "grep") return grepLike(rest, null);
      if (subcommand === "ls-files") {
        const { operands } = splitArgs(rest, new Set(["-x", "--exclude", "-X"]));
        return list(operands);
      }
      return null;
    }
    case "fd":
    case "fdfind": {
      const { operands, flags } = splitArgs(args, FD_FLAGS);
      if (hasFlag(flags, ["-x", "--exec", "-X", "--exec-batch"])) return null;
      const [pattern, path] = operands;
      return pattern === undefined ? list([]) : search(pattern, path);
    }
    case "find": {
      const firstExpression = args.findIndex(
        (arg) => arg.startsWith("-") || arg === "!" || arg === "(",
      );
      const paths = firstExpression < 0 ? args : args.slice(0, firstExpression);
      const expression = firstExpression < 0 ? [] : args.slice(firstExpression);
      if (expression.some((arg) => FIND_ACTIONS.has(arg))) return null;
      const nameIndex = expression.findIndex((arg) => FIND_NAME_TESTS.has(arg));
      const query = nameIndex < 0 ? undefined : expression[nameIndex + 1];
      return query === undefined ? list(paths.slice(0, 1)) : search(query, paths[0]);
    }
    default:
      return null;
  }
}

/** Pipeline filters that only reshape the previous command's output. */
function isOutputFilter(words: readonly string[]): boolean {
  const [program, ...args] = words;
  switch (program) {
    case "head":
    case "tail": {
      const { operands, flags } = splitArgs(args, HEAD_TAIL_FLAGS);
      if (flags.has("-f") || flags.has("-F") || flags.has("--follow")) return false;
      return operands.every((operand) => /^\+?\d+$/u.test(operand));
    }
    case "wc":
    case "nl":
    case "cat": {
      const { operands } = splitArgs(args, NL_FLAGS);
      return operands.length === 0;
    }
    case "sort": {
      // `sort -o FILE` writes, so accept only flags that cannot name an output.
      const { operands, flags } = splitArgs(args, new Set(["-k", "-t"]));
      return (
        operands.length === 0 &&
        [...flags.keys()].every(
          (flag) => flag === "-k" || flag === "-t" || /^-[bdfghinMRrsuVz]+$/u.test(flag),
        )
      );
    }
    case "uniq": {
      // A second operand is an output file.
      const { operands } = splitArgs(args, new Set(["-f", "-s", "-w"]));
      return operands.length === 0;
    }
    case "cut":
    case "tr":
    case "column":
      return true;
    case "sed":
      return args.length === 2 && args[0] === "-n" && SED_PRINT_SCRIPT.test(args[1]!);
    default:
      return false;
  }
}

function joinPath(base: string, path: string): string {
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/u.test(path)) return path;
  const trimmedBase = base.replace(/\/+$/u, "");
  const trimmedPath = path.replace(/^\.\//u, "");
  return trimmedPath === "." ? trimmedBase : `${trimmedBase}/${trimmedPath}`;
}

/** Unwraps `bash -lc '<script>'` style wrappers around a single script. */
function unwrapShell(words: readonly string[]): string | null {
  if (words.length !== 3) return null;
  const shell = words[0]!.split("/").at(-1)!;
  return SHELLS.has(shell) && (words[1] === "-c" || words[1] === "-lc") ? words[2]! : null;
}

function parse(command: string, depth: number): OrchestrationV2CommandAction[] {
  const tokens = tokenize(command.trim());
  if (tokens === null || tokens.length === 0) return [];

  const sequence: string[][][] = [[[]]];
  for (const token of tokens) {
    const pipeline = sequence.at(-1)!;
    if (token.kind === "word") pipeline.at(-1)!.push(token.value);
    else if (token.kind === "pipe") pipeline.push([]);
    else sequence.push([[]]);
  }
  if (sequence.some((pipeline) => pipeline.some((words) => words.length === 0))) return [];

  if (depth === 0 && sequence.length === 1 && sequence[0]!.length === 1) {
    const script = unwrapShell(sequence[0]![0]!);
    if (script !== null) return parse(script, depth + 1);
  }

  const actions: OrchestrationV2CommandAction[] = [];
  let cwd: string | null = null;
  for (const [first, ...filters] of sequence) {
    if (first![0] === "cd") {
      if (filters.length > 0 || first!.length !== 2) return [];
      cwd = cwd === null ? first![1]! : joinPath(cwd, first![1]!);
      continue;
    }
    const classified = classifySimpleCommand(first!);
    if (classified === null || !filters.every(isOutputFilter)) return [];
    for (const action of classified) {
      const located: OrchestrationV2CommandAction =
        action.type === "read" && cwd !== null
          ? { type: "read", path: joinPath(cwd, action.path) }
          : action;
      const previous = actions.at(-1);
      if (previous && JSON.stringify(previous) === JSON.stringify(located)) continue;
      actions.push(located);
    }
  }
  return actions;
}

/**
 * The read, list, and search steps of a shell command, or an empty list when
 * any step does something else or cannot be parsed with confidence.
 */
export function parseCommandActions(command: string): OrchestrationV2CommandAction[] {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) return [];
  const actions = parse(command, 0);
  return isCommandActions(actions) ? actions : [];
}
