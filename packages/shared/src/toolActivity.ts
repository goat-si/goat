import type { ToolLifecycleItemType } from "@goat/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function claudeSkillInvocation(
  toolName: string | null | undefined,
  input: unknown,
): { readonly name: string; readonly args: string | undefined } | undefined {
  if (toolName !== "Skill") return undefined;
  const record = asRecord(input);
  const name = asTrimmedString(record?.skill);
  return name === undefined ? undefined : { name, args: asTrimmedString(record?.args) };
}

export function isJavaScriptReplTool(toolName: string | null | undefined): boolean {
  return toolName === "js" || toolName === "cua_repl.js" || toolName === "node_repl.js";
}

export const COMPUTER_USE_TOOL_SOURCE = {
  key: "computer-use",
  name: "Computer Use",
  kind: "computer",
} as const;

// Codex and ACP name a call `server.tool`; Claude, Cursor and Pi `mcp__server__tool`; OpenCode
// `server_tool`, with a digest after the server name in OpenCode 2.
const CUA_DRIVER_TOOL = /^(?:cua-driver\.|mcp__cua-driver__|cua-driver(?:-[0-9a-f]+)?_)([a-z_]+)$/u;

/** The cua-driver tool a provider's call name refers to, such as `click`. */
export function cuaDriverToolName(toolName: string | null | undefined): string | undefined {
  return toolName ? CUA_DRIVER_TOOL.exec(toolName)?.[1] : undefined;
}

/** The input field that holds what a computer-use tool types into the screen. */
const TYPED_TEXT_FIELDS: Readonly<Record<string, string>> = {
  type_text: "text",
  set_value: "value",
};
/**
 * What the server sends in place of typed text. Only this exact object counts as redacted: any raw
 * value, even a string that reads "N characters", is the agent's text and gets redacted again.
 */
export interface ComputerUseRedactedText {
  readonly redactedCharacters: number;
}

function redactedMarker(value: unknown): ComputerUseRedactedText | undefined {
  const record = asRecord(value);
  if (record === undefined || Object.keys(record).length !== 1) return undefined;
  const count = record.redactedCharacters;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? { redactedCharacters: count }
    : undefined;
}

/** Where a computer-use call keeps its typed text: its input, or ACP's {server, tool, arguments}. */
function typedTextSlot(toolName: string | null | undefined, input: unknown) {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  const tool =
    cuaDriverToolName(toolName) ??
    (record.server === "cua-driver" && typeof record.tool === "string" ? record.tool : undefined);
  const field = tool === undefined ? undefined : TYPED_TEXT_FIELDS[tool];
  if (field === undefined) return undefined;
  if (record[field] !== undefined) return { record, field, value: record[field], nested: false };
  const nested = asRecord(record.arguments);
  return nested?.[field] === undefined
    ? undefined
    : { record, field, value: nested[field], nested: true };
}

const rawLength = (value: unknown) =>
  typeof value === "string" ? value.length : (JSON.stringify(value) ?? String(value)).length;

/** How many characters a computer-use call typed, read from its raw or redacted input. */
export function computerUseTypedTextLength(
  toolName: string | null | undefined,
  input: unknown,
): number | undefined {
  const slot = typedTextSlot(toolName, input);
  if (slot === undefined) return undefined;
  return redactedMarker(slot.value)?.redactedCharacters ?? rawLength(slot.value);
}

const typedLength = (value: unknown) =>
  redactedMarker(value)?.redactedCharacters ?? rawLength(value);

/** A run_steps step's own fields; any other key names its tool and holds its arguments. */
const STEP_KEYS: ReadonlySet<string> = new Set([
  "tool",
  "args",
  "wait_for",
  "expect",
  "timeout_ms",
]);
/** Step tool names the driver reads as type_text and set_value. */
const STEP_ALIASES: Readonly<Record<string, string>> = { type: "type_text", set: "set_value" };
/** A wait_for or expect check names a field's value, which can be what a step typed into it. */
const CHECK_VALUE_FIELDS = ["value", "value_contains"] as const;

/** Receives each typed value, raw or already a marker, and returns what takes its place. */
type ReplaceValue = (value: unknown) => unknown;

/** A copy of `record` with `fields` replaced, or undefined when it has none of them. */
function replaceFields(record: unknown, fields: ReadonlyArray<string>, replace: ReplaceValue) {
  const object = asRecord(record);
  const present = fields.filter((field) => object?.[field] !== undefined);
  if (object === undefined || present.length === 0) return undefined;
  return {
    ...object,
    ...Object.fromEntries(present.map((field) => [field, replace(object[field])])),
  };
}

/**
 * A check's value fields always go. Its text is usually words on screen and stays readable,
 * unless it repeats a value the same batch typed or checked.
 */
const replaceCheck = (check: unknown, replace: ReplaceValue, typed: ReadonlySet<string>) => {
  const text = asRecord(check)?.text;
  const repeats =
    typeof text === "string" &&
    (typed.has(text) || [...typed].some((value) => value.length >= 4 && text.includes(value)));
  return replaceFields(
    check,
    repeats ? [...CHECK_VALUE_FIELDS, "text"] : CHECK_VALUE_FIELDS,
    replace,
  );
};

const replaceChecks = (checks: unknown, replace: ReplaceValue, typed: ReadonlySet<string>) =>
  Array.isArray(checks)
    ? checks.map((check) => replaceCheck(check, replace, typed) ?? check)
    : replaceCheck(checks, replace, typed);

/**
 * One run_steps step, `{tool, args}` or `{<tool>: args}` as the driver reads it, with its typed
 * text and the field values its checks name replaced. The driver skips a null key, so every other
 * key that names a typing tool is treated as the action.
 */
function replaceStep(step: unknown, replace: ReplaceValue, typed: ReadonlySet<string>): unknown {
  const object = asRecord(step);
  if (object === undefined) return step;
  const fieldOf = (tool: unknown) =>
    typeof tool === "string" ? TYPED_TEXT_FIELDS[STEP_ALIASES[tool] ?? tool] : undefined;
  const actions: ReadonlyArray<readonly [string, string | undefined]> =
    object.tool !== undefined
      ? [["args", fieldOf(object.tool)]]
      : Object.keys(object)
          .filter((key) => !STEP_KEYS.has(key) && object[key] !== null)
          .map((key) => [key, fieldOf(key)]);
  const replaced = actions.flatMap(([key, field]) => {
    const args = field === undefined ? undefined : replaceFields(object[key], [field], replace);
    return args === undefined ? [] : [[key, args] as const];
  });
  const waitFor = replaceCheck(object.wait_for, replace, typed);
  const expect = replaceChecks(object.expect, replace, typed);
  return {
    ...object,
    ...Object.fromEntries(replaced),
    ...(waitFor === undefined ? {} : { wait_for: waitFor }),
    ...(expect === undefined ? {} : { expect }),
  };
}

/** A call's arguments with what it types replaced, or undefined when it types nothing. */
function replaceArguments(tool: string, args: unknown, replace: ReplaceValue): unknown {
  const field = TYPED_TEXT_FIELDS[tool];
  if (field !== undefined) return replaceFields(args, [field], replace);
  // A script's literals can hold what it types, and no parse can tell which; it shows as a length.
  if (tool === "run_script") return replaceFields(args, ["script"], replace);
  const steps = asRecord(args)?.steps;
  if (tool !== "run_steps" || !Array.isArray(steps)) return undefined;
  // What the batch types or checks, raw, so a text check that repeats it goes too.
  const typed = new Set<string>();
  for (const step of steps)
    replaceStep(
      step,
      (value) => {
        if (typeof value === "string" && value !== "") typed.add(value);
        return value;
      },
      new Set(),
    );
  return { ...asRecord(args), steps: steps.map((step) => replaceStep(step, replace, typed)) };
}

function replaceTypedValues(
  toolName: string | null | undefined,
  input: unknown,
  replace: ReplaceValue,
): unknown {
  const record = asRecord(input);
  if (record === undefined) return input;
  const tool =
    cuaDriverToolName(toolName) ??
    (record.server === "cua-driver" && typeof record.tool === "string" ? record.tool : undefined);
  if (tool === undefined) return input;
  const own = replaceArguments(tool, record, replace);
  if (own !== undefined) return own;
  const nested = replaceArguments(tool, record.arguments, replace);
  return nested === undefined ? input : { ...record, arguments: nested };
}

/**
 * The input with its typed text, raw or redacted, replaced by what `replace` makes of its length:
 * a type_text or set_value call's own, every one inside a run_steps batch, and a run_script source.
 */
export function replaceComputerUseTypedText(
  toolName: string | null | undefined,
  input: unknown,
  replace: (length: number) => unknown,
): unknown {
  return replaceTypedValues(toolName, input, (value) => replace(typedLength(value)));
}

/**
 * A computer-use call's input with its typed text replaced by a ComputerUseRedactedText (#1186).
 * The text can be a password, so nothing a client receives or exports carries it.
 */
export function redactComputerUseTypedText(
  toolName: string | null | undefined,
  input: unknown,
): unknown {
  return replaceComputerUseTypedText(toolName, input, (redactedCharacters) => ({
    redactedCharacters,
  }));
}

/** What a call's output shows in place of a value its input typed. */
const COMPUTER_USE_TYPED_OUTPUT = "[typed text]";
/** Shorter typed values are masked only as whole tokens, so "123" never eats into "1234". */
const MIN_EMBEDDED_TYPED_LENGTH = 4;
/** How many times a result may wrap JSON in a JSON string before it is masked as plain text. */
const MAX_JSON_DEPTH = 3;

const regexLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeJson = (text: string) => JSON.stringify(text).slice(1, -1);

/**
 * Whether a key of this output object carries protocol structure or binary data, never text: a
 * content block's type, an image's MIME type, and image data in either the MCP or the Claude shape.
 */
const structuralKey = (object: Record<string, unknown>, key: string) =>
  key === "type" ||
  key === "mimeType" ||
  key === "media_type" ||
  (key === "data" &&
    (object.type === "image" ||
      object.type === "base64" ||
      typeof object.mimeType === "string" ||
      typeof object.media_type === "string"));

/** A masker for plain text: literal replacement for long values, whole tokens for short ones. */
function typedTextMask(typed: ReadonlySet<string>) {
  // Each value as typed and as JSON escapes it, for text that quotes it inside a string.
  const forms = new Set<string>();
  for (const value of typed) {
    let form = value;
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth++) {
      forms.add(form);
      form = escapeJson(form);
    }
  }
  const sorted = [...forms].sort((left, right) => right.length - left.length);
  const long = sorted.filter((form) => form.length >= MIN_EMBEDDED_TYPED_LENGTH);
  // Short values go as whole tokens in any script. A lone punctuation mark, such as a quote,
  // would match all over the text, so it goes only where it is the whole string.
  const short = sorted.filter(
    (form) =>
      form.length < MIN_EMBEDDED_TYPED_LENGTH && (form.length > 1 || /[\p{L}\p{N}]/u.test(form)),
  );
  const tokens =
    short.length === 0
      ? undefined
      : new RegExp(
          `(?<![\\p{L}\\p{N}])(?:${short.map(regexLiteral).join("|")})(?![\\p{L}\\p{N}])`,
          "gu",
        );
  return (text: string) => {
    if (typed.has(text)) return COMPUTER_USE_TYPED_OUTPUT;
    let masked = text;
    for (const form of long) masked = masked.split(form).join(COMPUTER_USE_TYPED_OUTPUT);
    return tokens === undefined ? masked : masked.replace(tokens, COMPUTER_USE_TYPED_OUTPUT);
  };
}

/**
 * A computer-use call's output with every value its input typed masked, since a batch report can
 * echo a checked value. Text that is JSON is masked value by value and written back, so keys,
 * content types, MIME types and image data stay intact. A script's own results are page reads,
 * which private mode governs.
 */
export function redactComputerUseTypedOutput(
  toolName: string | null | undefined,
  input: unknown,
  output: unknown,
): unknown {
  const typed = new Set<string>();
  replaceTypedValues(toolName, input, (value) => {
    if (typeof value === "string" && value.length > 0) typed.add(value);
    return value;
  });
  if (typed.size === 0 || output === undefined) return output;
  const mask = typedTextMask(typed);
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return maskString(value, depth);
    if (Array.isArray(value)) return value.map((each) => walk(each, depth));
    const object = asRecord(value);
    return object === undefined
      ? value
      : Object.fromEntries(
          Object.entries(object).map(([key, each]) => [
            key,
            structuralKey(object, key) ? each : walk(each, depth),
          ]),
        );
  };
  const maskString = (text: string, depth: number): string => {
    // A typed value can itself be JSON; it goes whole before it is read as structure.
    if (typed.has(text)) return COMPUTER_USE_TYPED_OUTPUT;
    const start = text.trimStart()[0];
    if (depth < MAX_JSON_DEPTH && (start === "{" || start === "[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return mask(text);
      }
      const walked = walk(parsed, depth + 1);
      const written = JSON.stringify(walked);
      return written === JSON.stringify(parsed) ? text : written;
    }
    return mask(text);
  };
  return walk(output, 0);
}

export function dynamicToolSurface(toolName: string | null | undefined, input: unknown) {
  if (toolName === "cua_repl.js" || cuaDriverToolName(toolName) !== undefined) {
    return "computer" as const;
  }
  const code = asRecord(input)?.code;
  return isJavaScriptReplTool(toolName) &&
    typeof code === "string" &&
    (/\bsky\s*\./u.test(code) || /["']@oai\/sky["']/u.test(code))
    ? ("computer" as const)
    : undefined;
}

export function dynamicToolTitle(
  toolName: string | null | undefined,
  input: unknown,
  retainedTitle?: string | null,
): string | undefined {
  if (isJavaScriptReplTool(toolName)) {
    const title = asTrimmedString(retainedTitle);
    const meaningfulTitle =
      title && title.toLowerCase() !== "js" && title.toLowerCase() !== toolName?.toLowerCase()
        ? title
        : undefined;
    return (
      asTrimmedString(asRecord(input)?.title) ??
      meaningfulTitle ??
      (dynamicToolSurface(toolName, input) === "computer" ? "Computer use" : "Run JavaScript")
    );
  }
  const skill = claudeSkillInvocation(toolName, input);
  return skill === undefined ? undefined : `Skill: ${skill.name}`;
}

function recordHasKeys(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).length > 0;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

const PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "relativePath",
  "filename",
  "fileName",
  "newPath",
  "oldPath",
] as const;

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of PATH_KEYS) {
    const candidate = asTrimmedString(record[key]);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

export function collectToolFilePaths(data: unknown): string[] {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths;
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  return collectToolFilePaths(data)[0];
}

/** Preserve the first nonempty rawInput; later ACP updates often resend an empty object. */
export function mergeToolActivityData(
  previous: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  const previousRecord = asRecord(previous);
  const nextRecord = asRecord(next);
  if (!nextRecord) {
    return previousRecord;
  }
  if (!previousRecord) {
    return nextRecord;
  }
  const previousInput = asRecord(previousRecord.rawInput);
  const nextInput = asRecord(nextRecord.rawInput);
  const rawInput = recordHasKeys(nextInput)
    ? { ...previousInput, ...nextInput }
    : (previousInput ?? nextInput);
  const merged = { ...previousRecord, ...nextRecord };
  if (recordHasKeys(rawInput)) {
    merged.rawInput = rawInput;
  } else {
    delete merged.rawInput;
  }
  return merged;
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

export type ToolActivityAction = "command" | "read" | "file_change" | "search" | "other";

function toolNameToken(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed || /__|[./]/u.test(trimmed)) {
    return undefined;
  }
  return trimmed.replace(/[_\s-]/gu, "").toLowerCase();
}

export function classifyToolActivity(input: {
  readonly itemType?: ToolLifecycleItemType | string | null | undefined;
  readonly requestKind?: string | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): ToolActivityAction {
  const itemType = input.itemType ?? undefined;
  const requestKind = asTrimmedString(input.requestKind)?.toLowerCase();
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const toolName = toolNameToken(
    asTrimmedString(input.data?.toolName) ?? asTrimmedString(asRecord(input.data?.item)?.tool),
  );

  if (itemType === "command_execution") {
    return "command";
  }
  if (itemType === "image_view") {
    return "read";
  }
  if (itemType === "file_change") {
    return "file_change";
  }
  if (itemType === "web_search") {
    return "search";
  }
  if (requestKind === "command" || kind === "execute") {
    return "command";
  }
  if (
    requestKind === "file-change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (
    kind === "search" ||
    toolName === "find" ||
    toolName === "grep" ||
    toolName === "glob" ||
    toolName === "rg" ||
    toolName === "ls"
  ) {
    return "search";
  }
  if (requestKind === "file-read" || kind === "read") {
    return "read";
  }
  if (toolName === "terminal" || toolName === "bash" || toolName === "shell") {
    return "command";
  }
  if (toolName === "read" || toolName === "readfile") {
    return "read";
  }
  return "other";
}

const SEARCH_QUERY_KEYS = ["pattern", "query", "searchTerm", "regex", "grep", "needle"] as const;
const SEARCH_GLOB_KEYS = [
  "glob",
  "globPattern",
  "glob_pattern",
  "include",
  "filePattern",
  "file_pattern",
] as const;
const SEARCH_TARGET_KEYS = [
  "path",
  "target_directory",
  "targetDirectory",
  "directory",
  "cwd",
  "root",
] as const;

function firstInputString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function searchInputRecord(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return (
    [data?.rawInput, data?.input, asRecord(data?.item)?.input]
      .map(asRecord)
      .find((record) => recordHasKeys(record ?? undefined)) ?? data
  );
}

function searchTargetName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(/[\\/]/u).findLast((part) => part.length > 0 && part !== ".");
}

export function formatSearchToolLabel(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const input = searchInputRecord(data);
  const query = firstInputString(input, SEARCH_QUERY_KEYS);
  const glob = firstInputString(input, SEARCH_GLOB_KEYS);
  const target = searchTargetName(firstInputString(input, SEARCH_TARGET_KEYS));
  if (query && target) {
    return `Searched ${query} in ${target}`;
  }
  if (glob && target) {
    return `Searched files ${glob} in ${target}`;
  }
  if (glob) {
    return `Searched files ${glob}`;
  }
  if (query) {
    return `Searched ${query}`;
  }
  if (target) {
    return `Searched in ${target}`;
  }
  return undefined;
}

export function formatReadToolLabel(path: string, extraCount = 0): string {
  const trimmed = path.trim();
  const suffix = extraCount > 0 ? ` +${extraCount} more` : "";
  if (!trimmed) {
    return `Read file${suffix}`;
  }
  return `Read ${trimmed}${suffix}`;
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolActivity({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: formatReadToolLabel(primaryPath),
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const searchLabel = formatSearchToolLabel(data);
    if (searchLabel) {
      return { summary: searchLabel };
    }
    return {
      summary: "Searched files",
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
