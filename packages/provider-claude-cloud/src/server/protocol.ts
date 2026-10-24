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

/**
 * Claude's "Error:" text as it appears on screen, as lines. The native PTY spaces words with
 * cursor-column jumps and wraps long text with CR CR LF, so the jumps become spaces and the wrapped
 * lines that already arrived are kept. Callers redact before collapsing whitespace, so a masked
 * value still matches its original spacing.
 */
export function readDiagnostic(raw: string) {
  const screen = NodeUtil.stripVTControlCharacters(
    // eslint-disable-next-line no-control-regex -- Match the native PTY's cursor-column and cursor-forward sequences.
    raw.replace(/\u001b\[\d*[GC]/g, " "),
  ).replace(/\r+\n|\r/g, "\n");
  return /^\s*Error:\s*(\S.*(?:\n[ \t]*\S.*)*)\n/m.exec(screen)?.[1];
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
  // eslint-disable-next-line no-control-regex -- Match the native PTY's ESC cursor-column sequence.
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
  // Screen text turns cursor jumps into spaces and keeps wrapped lines, so a value can come back
  // with whitespace inside it. Mask it with any whitespace between its characters as well.
  for (const value of Object.values(environment)) {
    const compact = value?.replace(/\s+/g, "");
    if (compact && compact.length >= 6) text = text.replace(spacedPattern(compact), "[redacted]");
  }
  // A URL wrapped onto following lines keeps its continuation inside the mask.
  text = text.replace(/https?:\/\/[^\s<>]+(?:\n[^\s<>]+)*/g, "[link redacted]");
  text = text.replace(/(?:sk-ant-|Bearer\s+)[A-Za-z0-9_-]+/gi, "[redacted]");
  return text.slice(0, 1024).trim();
}

function spacedPattern(compact: string) {
  const characters = Array.from(compact, (character) =>
    character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(characters.join("\\s*"), "g");
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
