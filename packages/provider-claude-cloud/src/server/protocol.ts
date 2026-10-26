// @effect-diagnostics nodeBuiltinImport:off -- PTY control sequences are decoded at the CLI boundary.
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

/** Why readiness or login resolution refused, for callers that explain the next step. */
export const ClaudeCloudReason = Schema.Literals([
  "sibling_missing",
  "sibling_invalid",
  "forbidden_environment",
  "executable_unsupported",
  "not_signed_in",
  "wrong_sign_in",
  "cloud_unsupported",
  "folder_untrusted",
]);
export type ClaudeCloudReason = typeof ClaudeCloudReason.Type;

export class ClaudeCloudError extends Schema.TaggedError<ClaudeCloudError>()("ClaudeCloudError", {
  detail: Schema.String,
  outcome: Schema.Literals(["rejected", "uncertain"]),
  reason: Schema.optional(ClaudeCloudReason),
  /** Names, never values, of the variables behind `forbidden_environment`. */
  variables: Schema.optional(Schema.Array(Schema.String)),
  /** The sign-in method Claude reported, for `wrong_sign_in`. */
  authMethod: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

export const isClaudeCloudError = Schema.is(ClaudeCloudError);

const Auth = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.String,
  projectsDirectory: Schema.optional(Schema.String),
});
const Send = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), session_id: Schema.String, url: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export const parseAuth = Schema.decodeUnknownSync(Schema.fromJsonString(Auth));
export const parseAuthEffect = Schema.decodeUnknownEffect(Schema.fromJsonString(Auth));
const decodeSend = Schema.decodeUnknownSync(Schema.fromJsonString(Send));
export const SESSION_ID = /^session_[A-Za-z0-9]+$/;

export function sessionUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "claude.ai" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Invalid Claude session URL.");
  }
  const id = /^\/code\/(session_[A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
  if (!id) throw new Error("Invalid Claude session URL.");
  return { taskId: id, url: `https://claude.ai/code/${id}` };
}

export function cleanOutput(raw: string) {
  return NodeUtil.stripVTControlCharacters(raw).replace(/\r\n?/g, "\n");
}

/** One character of output; gap marks a cursor jump drawn just before it, jump a jump's own bytes. */
type Cell = { readonly character: string; readonly gap: boolean; readonly jump?: boolean };
type Token = {
  readonly character: string;
  readonly ids: ReadonlyArray<number>;
  readonly label?: string;
};

/**
 * Claude's "Error:" text as it appears on screen, redacted. The native PTY spaces words with
 * cursor-column jumps and wraps long text across lines. Redaction runs redact()'s exact steps on
 * exactly the text it always received (the first Error: line, cleaned twice), and again on each
 * wrapped line and on all lines joined; a character any pass masks or strips stays hidden. Only
 * then do the jumps that remain show as spaces. Returns "" when nothing readable is left.
 */
export function readDiagnostic(raw: string, environment: NodeJS.ProcessEnv) {
  const cells = cleanCells(rawCells(raw)).cells;
  const text = cellText(cells);
  const first = /^\s*Error:\s*(.+)\n/m.exec(text);
  const line = first?.[1];
  if (first === undefined || first === null || line === undefined) return undefined;
  const firstStart = first.index + first[0].length - 1 - line.length;
  const lines = [cells.slice(firstStart, firstStart + line.length)];
  // Claude wraps with CR CR LF, which reads as exactly one blank line once cleaned; a line right
  // after the error is other output, not a continuation.
  const rest = /^(?:\n[ \t]*\S[^\n]*\n)*/.exec(text.slice(first.index + first[0].length))?.[0];
  let offset = first.index + first[0].length;
  // Masks cover every candidate line; display stops at Claude's next record (the session receipt
  // or the folder trust question), so a value wrapped into that record still stays masked.
  let shownLines: number | undefined;
  for (const piece of (rest ?? "").split("\n").slice(0, -1)) {
    if (
      shownLines === undefined &&
      (/^\s*(?:Created cloud session:|View:|Resume with:)/.test(piece) ||
        FOLDER_QUESTION.test(piece))
    )
      shownLines = lines.length;
    if (piece.trim()) lines.push(cells.slice(offset, offset + piece.length));
    offset += piece.length + 1;
  }
  const block: Cell[] = [];
  const ranges: Array<readonly [number, number]> = [];
  let shownEnd = 0;
  for (const [index, cellsOfLine] of lines.entries()) {
    if (index > 0) block.push({ character: "\n", gap: false });
    ranges.push([block.length, block.length + cellsOfLine.length]);
    for (const cell of cellsOfLine) block.push(cell);
    if (shownLines === undefined || index < shownLines) shownEnd = block.length;
  }
  const marks = { hidden: new Set<number>(), masked: new Set<number>(), links: new Set<number>() };
  const pass = (start: number, end: number, link: RegExp) =>
    redactPass(block, start, end, environment, link, marks);
  for (const [start, end] of ranges) pass(start, end, /https?:\/\/[^\s<>]+/g);
  // A link wrapped onto following lines keeps its continuation inside the mask.
  pass(0, block.length, /https?:\/\/[^\s<>]+(?:\n[^\s<>]+)*/g);
  let shown = "";
  for (let index = 0; index < shownEnd; index++) {
    const cell = block[index];
    if (cell === undefined) continue;
    if (!marks.hidden.has(index)) {
      shown += (cell.gap ? " " : "") + cell.character;
      continue;
    }
    let link = false;
    let masked = false;
    for (; index < shownEnd && marks.hidden.has(index); index++) {
      link ||= marks.links.has(index);
      masked ||= marks.masked.has(index);
    }
    index--;
    if (masked) shown += link ? " [link redacted] " : " [redacted] ";
  }
  return shown.replace(/\s+/g, " ").slice(0, 1024).trim();
}

function rawCells(raw: string): Cell[] {
  const jumps = new Set<number>();
  for (const match of raw.matchAll(/\u001b\[\d*[GC]/g))
    for (let offset = 0; offset < match[0].length; offset++) jumps.add(match.index + offset);
  return Array.from({ length: raw.length }, (_, index) => ({
    character: raw.charAt(index),
    gap: false,
    jump: jumps.has(index),
  }));
}

/**
 * cleanOutput() on cells: the text is exactly cleanOutput's result, and each kept character keeps
 * its cell; removed cells are reported, and a removed jump marks the next kept character's gap.
 */
function cleanCells<T extends Cell>(cells: ReadonlyArray<T>) {
  const cleaned = cleanOutput(cellText(cells));
  const kept: Cell[] = [];
  const keptFrom: number[] = [];
  const removed: number[] = [];
  let cursor = 0;
  let pendingGap = false;
  for (let offset = 0; offset < cleaned.length; offset++) {
    const character = cleaned.charAt(offset);
    while (cursor < cells.length) {
      const candidate = cells[cursor]?.character;
      if (candidate === character || (character === "\n" && candidate === "\r")) break;
      pendingGap ||= cells[cursor]?.jump === true || cells[cursor]?.gap === true;
      removed.push(cursor);
      cursor++;
    }
    const cell = cells[cursor];
    kept.push({ character, gap: pendingGap || (cell?.gap ?? false) });
    keptFrom.push(cursor);
    pendingGap = false;
    cursor++;
    if (character === "\n" && cell?.character === "\r" && cells[cursor]?.character === "\n") {
      removed.push(cursor);
      cursor++;
    }
  }
  for (; cursor < cells.length; cursor++) removed.push(cursor);
  return { cells: kept, keptFrom, removed };
}

const cellText = (cells: ReadonlyArray<{ readonly character: string }>) =>
  cells.map((cell) => cell.character).join("");

/** redact()'s steps on block[start, end), tracking which block characters each label covers. */
function redactPass(
  block: ReadonlyArray<Cell>,
  start: number,
  end: number,
  environment: NodeJS.ProcessEnv,
  link: RegExp,
  marks: {
    // Every character a pass masked or stripped; masked ones were replaced by a label.
    readonly hidden: Set<number>;
    readonly masked: Set<number>;
    readonly links: Set<number>;
  },
) {
  const slice = block.slice(start, end);
  const cleaned = cleanCells(slice);
  for (const index of cleaned.removed) marks.hidden.add(start + index);
  let tokens: Token[] = cleaned.cells.map((cell, index) => ({
    character: cell.character,
    ids: [start + (cleaned.keptFrom[index] ?? 0)],
  }));
  const replace = (matches: ReadonlyArray<readonly [number, number]>, label: string) => {
    const next: Token[] = [];
    let cursor = 0;
    for (const [index, length] of matches) {
      // Loops, not spreads: a 64 KiB diagnostic overflows the call stack as arguments.
      for (let at = cursor; at < index; at++) {
        const token = tokens[at];
        if (token) next.push(token);
      }
      // Label characters share one array, so a union of their ids stays small.
      const union = new Set<number>();
      for (let at = index; at < index + length; at++)
        for (const id of tokens[at]?.ids ?? []) union.add(id);
      const ids = Array.from(union);
      for (let offset = 0; offset < label.length; offset++)
        next.push({ character: label.charAt(offset), ids, label });
      cursor = index + length;
    }
    for (let at = cursor; at < tokens.length; at++) {
      const token = tokens[at];
      if (token) next.push(token);
    }
    tokens = next;
  };
  for (const value of Object.values(environment)) {
    if (!value || value.length < 6) continue;
    const text = cellText(tokens);
    const matches: Array<readonly [number, number]> = [];
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length))
      matches.push([at, value.length]);
    if (matches.length > 0) replace(matches, "[redacted]");
  }
  const found = (pattern: RegExp) =>
    Array.from(
      cellText(tokens).matchAll(pattern),
      (match) => [match.index, match[0].length] as const,
    );
  replace(found(link), "[link redacted]");
  replace(found(/(?:sk-ant-|Bearer\s+)[A-Za-z0-9_-]+/gi), "[redacted]");
  for (const token of tokens) {
    if (token.label === undefined) continue;
    for (const id of token.ids) {
      marks.hidden.add(id);
      marks.masked.add(id);
      if (token.label === "[link redacted]") marks.links.add(id);
    }
  }
}

export function readStartReceipt(raw: string) {
  const normalized = cleanOutput(raw);
  // Parse only terminated lines; a chunk can split a session ID or ANSI sequence.
  const text = normalized.slice(0, normalized.lastIndexOf("\n") + 1);
  const titles = [...text.matchAll(/^\s*Created cloud session:\s*(.+)$/gm)];
  const views = [...text.matchAll(/^\s*View:\s*(https:\/\/\S+)\s*$/gm)];
  const resumes = [
    ...text.matchAll(/^\s*Resume with:\s*claude --teleport (session_[A-Za-z0-9]+)\s*$/gm),
  ];
  if (!titles.length || !views.length || !resumes.length) return undefined;
  const receipts = views.map((match) => sessionUrl(match[1]!));
  const first = receipts[0]!;
  if (
    receipts.some((receipt) => receipt.taskId !== first.taskId) ||
    resumes.some((match) => match[1] !== first.taskId)
  ) {
    throw new Error("Conflicting Claude cloud session identities.");
  }
  return { ...first, title: titles[0]![1]!.trim().slice(0, 512) };
}

function trustText(raw: string) {
  // Native trust options use absolute cursor columns as word spacing; preserve those boundaries.
  return cleanOutput(raw.replace(/\u001b\[\d+G/g, " ")).replace(
    /^\s*(?:Created cloud session:|View:|Resume with:).*$/gm,
    "",
  );
}

const FOLDER_QUESTION =
  /^\s*(?:[❯>]\s*)?(?:Do you trust (?:the files in this folder|this (?:folder|directory))\?|Trust (?:this (?:folder|directory)|the files in this folder)\?)[ \t]*$/im;
const FOLDER_YES = /^\s*(?:[❯>]\s*)?(?:1\.\s*)?Yes, I trust this folder[ \t]*$/im;
// "Yes, proceed" is generic, so it only counts beneath the folder question.
const PROCEED = /^\s*(?:[❯>]\s*)?(?:1\.\s*)?Yes, proceed[ \t]*$/im;
// Refusals need a terminated line; a chunk may end before a generic diagnostic's qualifier.
const FOLDER_REFUSAL =
  /^\s*(?:Error:\s*)?(?:This (?:folder|directory) is not trusted|Workspace trust is required for this (?:folder|directory)|Claude Code cannot run in an untrusted (?:folder|directory))[.!]?[ \t]*\n/im;

/** Claude's folder trust dialog is on screen, possibly before its options have rendered. */
export function trustPrompt(raw: string) {
  const text = trustText(raw);
  return FOLDER_QUESTION.test(text) || FOLDER_YES.test(text);
}

/** The dialog's "yes" option has rendered, so Enter on its default selection trusts the folder. */
export function trustOption(raw: string) {
  const text = trustText(raw);
  return FOLDER_YES.test(text) || (FOLDER_QUESTION.test(text) && PROCEED.test(text));
}

/** Claude refused to run in the folder without asking. */
export function trustRefusal(raw: string) {
  return FOLDER_REFUSAL.test(trustText(raw));
}

const DIALOG_OPTION =
  /^\s*([❯>]\s*)?(?:\d+\.\s*)?(Yes, I trust this folder|Yes, proceed|No, exit|No)\b/;

/**
 * The trust dialog's options in screen order and which one is highlighted. Claude 2.1.306
 * highlights "No, exit" first, so Enter alone would decline.
 */
export function trustDialog(raw: string) {
  if (!trustOption(raw)) return undefined;
  const options: Array<{ readonly yes: boolean; readonly marked: boolean }> = [];
  for (const line of trustText(raw).split("\n")) {
    const match = DIALOG_OPTION.exec(line);
    if (match) options.push({ yes: match[2]!.startsWith("Yes"), marked: match[1] !== undefined });
  }
  const yes = options.findIndex((option) => option.yes);
  const marked = options.findIndex((option) => option.marked);
  // Without a marker, Claude's first option is the highlighted one.
  return yes < 0 ? undefined : { yes, marked: marked < 0 ? 0 : marked };
}

export function trustRequired(raw: string) {
  return trustPrompt(raw) || trustRefusal(raw);
}

export function redact(detail: string, environment: NodeJS.ProcessEnv) {
  let text = cleanOutput(detail);
  for (const value of Object.values(environment)) {
    if (value && value.length >= 6) text = text.split(value).join("[redacted]");
  }
  text = text.replace(/https?:\/\/[^\s<>]+/g, "[link redacted]");
  text = text.replace(/(?:sk-ant-|Bearer\s+)[A-Za-z0-9_-]+/gi, "[redacted]");
  return text.slice(0, 1024).trim();
}

export function readSendReceipt(raw: string, expectedId: string, environment: NodeJS.ProcessEnv) {
  if (!SESSION_ID.test(expectedId)) {
    throw new ClaudeCloudError({
      detail: "Invalid saved Claude session ID. No follow-up is safe.",
      outcome: "uncertain",
    });
  }
  const result = decodeSend(raw.trim());
  if (!result.ok)
    throw new ClaudeCloudError({
      detail: redact(result.error, environment) || "Claude rejected the follow-up.",
      outcome: "rejected",
    });
  const link = sessionUrl(result.url);
  if (
    !SESSION_ID.test(result.session_id) ||
    result.session_id !== expectedId ||
    link.taskId !== expectedId
  ) {
    throw new ClaudeCloudError({
      detail:
        "Claude returned a different cloud session. Delivery is uncertain; open the existing session before sending again.",
      outcome: "uncertain",
    });
  }
  return link;
}

export function prepareClaudeCloudEnvironment(environment: NodeJS.ProcessEnv) {
  // An empty Git pager disables paging (including PAGER fallback) for unattended CLI calls.
  // Keep the explicit empty value so a spawner cannot re-inherit the parent's pager command.
  return environment.GIT_PAGER ? { ...environment, GIT_PAGER: "" } : environment;
}

/** Reject routing overrides and return the child environment without mutating the sibling. */
export function validateLogin(login: {
  readonly binary: string;
  readonly binding: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const environment = prepareClaudeCloudEnvironment(login.environment);
  const forbidden = [
    "CCR_FORCE_BUNDLE",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ];
  if (
    !login.binary.trim() ||
    !login.binding.trim() ||
    forbidden.some((key) => environment[key]?.trim()) ||
    Object.entries(environment).some(([key, value]) => key.startsWith("GIT_") && value)
  ) {
    throw new ClaudeCloudError({
      outcome: "rejected",
      detail:
        "Claude Cloud requires the selected native Claude binary and claude.ai login without bundle, API-key, Git or third-party routing overrides.",
    });
  }
  return environment;
}
