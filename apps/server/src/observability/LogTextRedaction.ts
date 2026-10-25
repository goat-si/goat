import { redactGoatCredentials } from "../mcp/goatCredentialRedaction.ts";

/**
 * Credentials in log text, recognized by their shape and masked whole: GOAT MCP credentials,
 * bare JWT and JWE tokens, Authorization header values, Cookie and Set-Cookie headers, URL
 * userinfo, provider token shapes, PEM private-key blocks, and the values of fields and
 * assignments named in CREDENTIAL_KEY. Every pattern runs in time linear in the text; see
 * LogRedaction.ts for the guarantee this serves.
 */

export const MASK = "***";

// A field name whose value is a credential, in snake, kebab or camel case.
const CREDENTIAL_KEY = String.raw`(?:(?:access|refresh|id|session|auth|bearer|csrf|xsrf|api|client)[_-]?)?token|(?:x[_-])?api[_-]?key|client[_-]?secret|secret|password|passwd|authorization|(?:set[_-]?)?cookie`;
export const isCredentialKey = new RegExp(`^(?:${CREDENTIAL_KEY})$`, "i");

/**
 * A quoted field name followed by a colon, in JSON escaped inside another JSON string, in JSON,
 * and in a single-quoted repr. Names are decoded before they are compared, so an escaped spelling
 * such as "to\u006ben" is still a token. Name length is bounded so scanning stays linear.
 */
const FIELD_NAMES = [
  {
    // Whitespace around the colon may itself be escaped (\n, \r, \t) in escaped JSON.
    name: new RegExp(
      String.raw`\\"((?:\\\\(?:\\\\|\\"|[^\\"])|[^\\"]){1,128})\\"(?:\s|\\[nrt])*:(?:\s|\\[nrt])*`,
      "g",
    ),
    escaped: true,
    decode: (raw: string) => jsonString(raw.replace(/\\(\\|")/g, "$1")),
  },
  {
    name: new RegExp(String.raw`"((?:\\.|[^"\\]){1,128})"\s*:\s*`, "g"),
    escaped: false,
    decode: jsonString,
  },
  {
    name: new RegExp(String.raw`'((?:\\.|[^'\\]){1,128})'\s*:\s*`, "g"),
    escaped: false,
    decode: (raw: string) => jsonString(raw.replace(/\\'/g, "'").replace(/"/g, '\\"')),
  },
];

function jsonString(body: string): string {
  try {
    const value: unknown = JSON.parse(`"${body}"`);
    return typeof value === "string" ? value : body;
  } catch {
    return body;
  }
}

const ESCAPED_QUOTE = '\\"';
const ESCAPED_BACKSLASH = "\\\\";

/**
 * Where the JSON value starting at start ends: a string up to its own closing quote, an array or
 * object up to its matching bracket, a bare value up to a separator. In escaped JSON, quotes and
 * backslashes are themselves escaped. A value that never closes runs to the end of the text, so a
 * cut or malformed value is hidden whole.
 */
function valueEnd(text: string, start: number, escaped: boolean): number {
  let depth = 0;
  let quote: string | undefined;
  let index = start;
  while (index < text.length) {
    if (quote !== undefined) {
      if (escaped) {
        if (text.startsWith(ESCAPED_BACKSLASH, index)) {
          const next = text.slice(index + 2, index + 4);
          index += next === ESCAPED_BACKSLASH || next === ESCAPED_QUOTE ? 4 : 3;
          continue;
        }
        if (text.startsWith(ESCAPED_QUOTE, index)) {
          quote = undefined;
          index += 2;
          if (depth === 0) return index;
          continue;
        }
      } else if (text[index] === "\\") {
        index += 2;
        continue;
      } else if (text[index] === quote) {
        quote = undefined;
        index += 1;
        if (depth === 0) return index;
        continue;
      }
      index += 1;
      continue;
    }
    const char = text.charAt(index);
    if (escaped ? text.startsWith(ESCAPED_QUOTE, index) : char === '"' || char === "'") {
      quote = escaped ? ESCAPED_QUOTE : char;
      index += quote.length;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      if (depth === 0) return index;
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (depth === 0 && (char === "," || char === "\\" || /\s/.test(char))) return index;
    index += 1;
  }
  return text.length;
}

/** Every credential-named field's whole value replaced; see {@link valueEnd}. */
function maskCredentialFields(text: string): string {
  let masked = text;
  for (const { name, escaped, decode } of FIELD_NAMES) {
    let out = "";
    let shown = 0;
    name.lastIndex = 0;
    for (let match = name.exec(masked); match !== null; match = name.exec(masked)) {
      if (match.index < shown || !isCredentialKey.test(decode(match[1] ?? ""))) continue;
      const start = match.index + match[0].length;
      const end = valueEnd(masked, start, escaped);
      out += masked.slice(shown, start) + MASK;
      shown = end;
      name.lastIndex = Math.max(end, start);
    }
    masked = out + masked.slice(shown);
  }
  return masked;
}

/** Whether a base64url part decodes to a JWT or JWE header: a JSON object naming its alg. */
function isJoseHeader(part: string): boolean {
  const decoded = Buffer.from(part, "base64url").toString("utf8");
  if (!/^\s*\{/.test(decoded)) return false;
  try {
    const header: unknown = JSON.parse(decoded);
    return typeof header === "object" && header !== null && "alg" in header;
  } catch {
    return false;
  }
}

/**
 * Whether a JSON object, or the whitespace JSON allows before one, can start decoding at this
 * offset: "{" encodes as e then one of w-z, 0-9, - or _; space as I then A-P; tab and CR as C or D
 * then Q-Z or a-f; line feed as C then g-v. Two characters screen an offset without decoding.
 */
function mayStartObject(part: string, offset: number): boolean {
  const lead = part.charAt(offset);
  const next = part.charAt(offset + 1);
  if (lead === "e") return /[w-z0-9_-]/.test(next);
  if (lead === "I") return /[A-P]/.test(next);
  if (lead === "C") return /[Q-Za-v]/.test(next);
  if (lead === "D") return /[Q-Za-f]/.test(next);
  return false;
}

const MAX_HEADER_CHECKS = 8;

/**
 * Where a JOSE header starts inside a base64url part, if one does. Text joined to the token without
 * a dot (jwt-, id_, a word) shares its first part, so every offset is tried. A two-character screen
 * and a short decode keep that linear; a part that keeps looking like a header after a few full
 * checks is masked from its first candidate rather than checked without end.
 */
function headerOffset(part: string, accepts: (rest: string) => boolean): number | undefined {
  let first: number | undefined;
  let checks = 0;
  for (let offset = 0; offset <= part.length - 8; offset++) {
    if (!mayStartObject(part, offset)) continue;
    const rest = part.slice(offset);
    // Twelve decoded bytes show whether an object starts here. A header led by whitespace is also
    // found from a later offset in that whitespace, four characters apart, closer to its "{".
    if (!/^\s*\{/.test(Buffer.from(rest.slice(0, 16), "base64url").toString("utf8"))) continue;
    first ??= offset;
    if (++checks > MAX_HEADER_CHECKS) return first;
    if (accepts(rest)) return withLeadingWhitespace(part, offset);
  }
  return undefined;
}

/** The offset moved back over whole base64 groups that decode to whitespace before the header. */
function withLeadingWhitespace(part: string, offset: number): number {
  let start = offset;
  while (
    start >= 4 &&
    /^\s+$/.test(Buffer.from(part.slice(start - 4, start), "base64url").toString("utf8"))
  )
    start -= 4;
  return start;
}

/** A dotted run with every part from a JOSE header on masked, keeping any text joined before it. */
function maskFromHeader(
  parts: ReadonlyArray<string>,
  acceptsAt: (index: number) => ((rest: string) => boolean) | undefined,
): string | undefined {
  for (let index = 0; index < parts.length; index++) {
    const accepts = acceptsAt(index);
    if (accepts === undefined) continue;
    const part = parts[index] ?? "";
    const offset = headerOffset(part, accepts);
    if (offset !== undefined)
      return [...parts.slice(0, index), part.slice(0, offset) + MASK].join(".");
  }
  return undefined;
}

/**
 * A cut text can end inside a token whose remaining dots fall past the cut. Its trailing dotted
 * run is masked from any JOSE header, or from a last part that the cut leaves as the start of a
 * JSON object, so an unfinished token or header is hidden as well.
 */
function maskUnfinishedJose(text: string): string {
  let start = text.length;
  while (start > 0 && /[A-Za-z0-9_.-]/.test(text.charAt(start - 1))) start -= 1;
  const parts = text.slice(start).split(".");
  const masked = maskFromHeader(parts, (index) =>
    index === parts.length - 1
      ? (rest) => startsJsonObject(rest) || isJoseHeader(rest)
      : isJoseHeader,
  );
  return masked === undefined ? text : text.slice(0, start) + masked;
}

/**
 * A URL authority that the scan cut runs through may still hold userinfo whose @ lies past the
 * cut, so it is masked from its scheme to the cut, as an unfinished JOSE token is.
 */
function maskUnfinishedUrl(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\r\n?#]*$/i, `$1${MASK}`);
}

function startsJsonObject(part: string): boolean {
  // The whole part is decoded: a header may open with any amount of whitespace.
  return /^\s*\{/.test(Buffer.from(part, "base64url").toString("utf8"));
}

/** Whether a whole base64url part decodes to a JSON object: a JWS payload. */
function isJsonObject(part: string): boolean {
  if (part.length < 2 || !mayStartObject(part, 0)) return false;
  const decoded = Buffer.from(part, "base64url").toString("utf8");
  // Parse only what could be a whole object: a failed parse costs far more than this check.
  if (!/\}\s*$/.test(decoded)) return false;
  try {
    const value: unknown = JSON.parse(decoded);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * A dotted run from its first JOSE header on, masked; otherwise the run itself. A JWS is also known
 * by its payload, which no text can join: the part before a payload is masked whole, with whatever
 * was joined to its header, when a header cannot be found in it.
 */
function maskJoseToken(run: string): string {
  const parts = run.split(".");
  const fromHeader = maskFromHeader(parts, (index) =>
    index + 2 < parts.length ? isJoseHeader : undefined,
  );
  if (fromHeader !== undefined) return fromHeader;
  for (let index = 0; index + 2 < parts.length; index++)
    if (isJsonObject(parts[index + 1] ?? "")) return [...parts.slice(0, index), MASK].join(".");
  return run;
}

// key=value or key: value for every credential name a field is masked by.
const ASSIGNMENT = new RegExp(String.raw`\b(${CREDENTIAL_KEY})\s*[=:]\s*`, "gi");
// A scheme word alone on its line, "authorization=Bearer" then a line break, still leads the
// credential on the next line that holds anything. Sticky, so it is tried once at the value's start.
const LONE_SCHEME_WORD = /[A-Za-z][\w+.~-]*[ \t]*[\r\n]\s*(?=\S)/y;

/**
 * Every assignment to a credential name with its whole value masked: a JSON value up to its
 * closing bracket ({@link valueEnd}), an authorization or cookie value up to the end of its line,
 * otherwise a shell word, quoted segments and all, as in password='first'second. The key and its
 * = or : stay.
 */
function maskAssignments(text: string): string {
  let out = "";
  let shown = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(text); match !== null; match = ASSIGNMENT.exec(text)) {
    const start = match.index + match[0].length;
    if (match.index < shown || start >= text.length) continue;
    const lead = text.charAt(start);
    const key = match[1] ?? "";
    // An authorization or cookie value is a list of words, "Custom+Scheme realm=x, credential" or
    // "a=1; sid=2", so it runs to the end of its line.
    const end =
      lead === "{" || lead === "["
        ? valueEnd(text, start, false)
        : /^authorization$/i.test(key)
          ? wordEnd(text, start + loneSchemeLength(text, start), /[\r\n]/)
          : /^cookie$/i.test(key)
            ? wordEnd(text, start, /[\r\n]/)
            : wordEnd(text, start, /\s/);
    if (end === start) continue;
    out += text.slice(shown, start) + MASK;
    shown = end;
    ASSIGNMENT.lastIndex = end;
  }
  return out + text.slice(shown);
}

function loneSchemeLength(text: string, start: number): number {
  LONE_SCHEME_WORD.lastIndex = start;
  return LONE_SCHEME_WORD.exec(text)?.[0].length ?? 0;
}

/**
 * The end of an unbracketed value: up to an unquoted, unescaped stop character (whitespace for a
 * shell word, a line break for a line), with quoted segments and escapes inside.
 */
function wordEnd(text: string, start: number, stop: RegExp): number {
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (stop.test(char)) break;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index += 1;
      while (index < text.length && text.charAt(index) !== char)
        index += text.charAt(index) === "\\" && char === '"' ? 2 : 1;
    }
    index += 1;
  }
  return Math.min(index, text.length);
}

const PRIVATE_KEY_MARKER =
  /-----(BEGIN|END) ((?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY(?: BLOCK)?)-----/g;

/**
 * Every PEM private-key block with its body masked and its outer markers kept. A block ends only at
 * the END marker of its own label, after the blocks nested in it; a block that never ends, cut or
 * malformed, is masked to the end of the text. Markers are read in one pass, so scanning stays
 * linear.
 */
function maskPrivateKeys(text: string): string {
  let out = "";
  let shown = 0;
  const open: Array<string> = [];
  PRIVATE_KEY_MARKER.lastIndex = 0;
  for (
    let marker = PRIVATE_KEY_MARKER.exec(text);
    marker !== null;
    marker = PRIVATE_KEY_MARKER.exec(text)
  ) {
    const [whole, kind, label = ""] = marker;
    if (kind === "BEGIN") {
      if (open.length === 0) out += text.slice(shown, marker.index + whole.length) + MASK;
      open.push(label);
    } else if (open.at(-1) === label) {
      open.pop();
      if (open.length === 0) shown = marker.index;
    }
  }
  return open.length > 0 ? out : out + text.slice(shown);
}

// The start of every provider token REDACTIONS recognizes by its prefix.
const TOKEN_PREFIX = /gh[pousr]_|github_pat_|[sr]k-|[sr]k_(?:live|test)_|AKIA|AIza|xox[a-z]-|xapp-/;

/**
 * A cut text can end inside a provider token, leaving it shorter than its pattern needs. A last
 * word holding the start of one, "id-xoxb-12" as much as "xoxb-12", is masked from that start.
 */
function maskUnfinishedToken(text: string): string {
  let start = text.length;
  while (start > 0 && /[A-Za-z0-9_-]/.test(text.charAt(start - 1))) start -= 1;
  const prefix = text.slice(start).search(TOKEN_PREFIX);
  return prefix === -1 ? text : text.slice(0, start + prefix) + MASK;
}

const REDACTIONS: ReadonlyArray<readonly [RegExp, string | ((match: string) => string)]> = [
  // Cookie and Set-Cookie headers hold every cookie up to the end of the header, including
  // folded continuation lines (a line break followed by a space or tab).
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+(?:(?:\r?\n|\r)[ \t][^\r\n]*)*/gi, `$1${MASK}`],
  // A JWT or JWE: dotted base64url parts led by one that decodes to a JSON header, whatever
  // whitespace the header holds. Each part of a dotted run is tried, so a dotted prefix cannot
  // hide a token, and dotted names such as serverLogger.test.ts are left alone.
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){2,}/g, maskJoseToken],
  // https://user:token@host/repo.git. Userinfo runs to the authority's last @, as URL parsers read
  // it, so a password holding @ is hidden whole. Parsers end an authority only at /, ? or #, and
  // accept spaces and tabs in userinfo, so it may hold them within one line; a pathless URL
  // followed on its line by an @ is masked up to that @. The scheme is bounded (a longer run is
  // matched by its end) and an authority ends at the next slash, so scanning stays linear.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\r\n?#]*@/gi, `$1${MASK}@`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  // Stripe secret and restricted keys; publishable pk_ keys are meant to be public.
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, MASK],
  // Slack bot, user, app, refresh and legacy tokens, and Google API keys.
  [/\b(?:xoxe\.)?(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${MASK}`],
  // An Authorization header holds its scheme and every parameter up to the end of the header,
  // including folded continuation lines.
  [/\b(authorization\s*:\s*)[^\r\n]+(?:(?:\r?\n|\r)[ \t][^\r\n]*)*/gi, `$1${MASK}`],
];

const MAX_STRING = 32_000;
// Only the start of a huge text can be shown; scanning all of it would slow every log call.
const MAX_SCANNED = 8 * MAX_STRING;

/**
 * A cut text with whatever credential its cut leaves unfinished masked. The JOSE and provider token
 * passes each mask a tail of the text, so both read the cut text itself and the longer mask wins:
 * neither can hide from the other the run it needs to see.
 */
function maskUnfinished(cut: string): string {
  const jose = maskUnfinishedJose(cut);
  const token = maskUnfinishedToken(cut);
  return maskUnfinishedUrl(jose.length <= token.length ? jose : token);
}

/** Text with credentials replaced, then cut to a bound, so the cut never splits a credential. */
export function redactLogText(text: string): string {
  const scanned = text.length <= MAX_SCANNED ? text : maskUnfinished(text.slice(0, MAX_SCANNED));
  const redacted = REDACTIONS.reduce(
    (current, [pattern, replacement]) =>
      typeof replacement === "string"
        ? current.replace(pattern, replacement)
        : current.replace(pattern, replacement),
    maskCredentialFields(redactGoatCredentials(maskPrivateKeys(scanned))),
  );
  const assigned = maskAssignments(redacted);
  return assigned.length <= MAX_STRING && scanned === text
    ? assigned
    : `${assigned.slice(0, MAX_STRING)}…[cut from ${text.length} characters]`;
}
