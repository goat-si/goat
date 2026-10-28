/**
 * Carries a cell's top-level declarations into the next cell. The scan is lexical and only picks
 * the names to try: QuickJS compiles the result, and the guest keeps a name only when it is the
 * cell's own binding. A miss keeps one value less; it never changes what the cell does.
 */

interface Token {
  readonly kind: "word" | "punct" | "value";
  readonly value: string;
  readonly depth: number;
  readonly lineBreakBefore: boolean;
  /** Offset in the source, so adjacent punctuation can be read as one operator. */
  readonly start: number;
  /** On a `)` or `}`: whether a `/` after it starts a regex (a block, or an if/while/for header). */
  readonly regexAfter?: boolean;
}

const RESERVED = new Set(
  (
    "arguments await break case catch class const continue debugger default delete do else enum " +
    "eval export extends false finally for function if implements import in instanceof interface " +
    "let new null package private protected public return static super switch this throw true try " +
    "typeof undefined var void while with yield NaN Infinity"
  ).split(" "),
);
const REGEX_AFTER_WORDS = new Set(
  "return typeof instanceof in of new delete void throw case do else await yield".split(" "),
);
const CONTROL_HEADERS = new Set(["if", "while", "for", "with"]);
const NAME = /^[A-Za-z_$][\w$]*$/;
const MAX_NAMES = 256;
const isWordChar = (c: string) => /[\w$]/.test(c) || (c !== "" && c.charCodeAt(0) > 127);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const templates: number[] = [];
  let depth = 0;
  let lineBreak = false;
  let i = 0;
  let from = 0;
  /** For each open bracket, whether a `/` after its close starts a regex. */
  const openers: boolean[] = [];
  const at = (index: number) => source.charAt(index);
  const push = (kind: Token["kind"], value: string, regexAfter?: boolean) => {
    tokens.push({
      kind,
      value,
      depth,
      lineBreakBefore: lineBreak,
      start: from,
      ...(regexAfter === undefined ? {} : { regexAfter }),
    });
    lineBreak = false;
  };
  const regexAllowed = () => {
    const previous = tokens.at(-1);
    if (previous === undefined) return true;
    if (previous.kind === "word") return REGEX_AFTER_WORDS.has(previous.value);
    if (previous.kind === "value") return false;
    if (previous.value === ")" || previous.value === "}") return previous.regexAfter === true;
    return previous.value !== "]";
  };
  // A brace after an operator or an expression keyword opens an object; otherwise it opens a block.
  const braceOpensBlock = () => {
    const previous = tokens.at(-1);
    if (previous === undefined) return true;
    if (previous.kind === "word")
      return (
        !REGEX_AFTER_WORDS.has(previous.value) ||
        previous.value === "do" ||
        previous.value === "else"
      );
    if (previous.kind === "value") return true;
    if (
      previous.value === ">" &&
      tokens.at(-2)?.value === "=" &&
      tokens.at(-2)?.start === previous.start - 1
    )
      return true;
    return (
      previous.value === ")" ||
      previous.value === "}" ||
      previous.value === ";" ||
      previous.value === "{"
    );
  };
  // Template text up to its end, or up to a `${` whose expression the main loop then reads.
  const templateText = () => {
    while (i < source.length) {
      const c = at(i);
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        push("value", "`");
        return;
      } else if (c === "$" && at(i + 1) === "{") {
        i += 2;
        templates.push(depth);
        depth++;
        return;
      } else i++;
    }
  };
  while (i < source.length) {
    const c = at(i);
    from = i;
    if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") {
      lineBreak = true;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && at(i + 1) === "/") {
      while (i < source.length && at(i) !== "\n" && at(i) !== "\r") i++;
    } else if (c === "/" && at(i + 1) === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      if (/[\n\r\u2028\u2029]/.test(source.slice(i, stop))) lineBreak = true;
      i = stop;
    } else if (c === "'" || c === '"') {
      const start = i;
      i++;
      while (i < source.length && at(i) !== c && at(i) !== "\n") i += at(i) === "\\" ? 2 : 1;
      i++;
      push("value", source.slice(start, i));
    } else if (c === "`") {
      i++;
      templateText();
    } else if (c === "/" && regexAllowed()) {
      let inClass = false;
      i++;
      while (i < source.length && at(i) !== "\n") {
        const r = at(i);
        if (r === "\\") i++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < source.length && /[\w$]/.test(at(i))) i++;
      push("value", "/");
    } else if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
      const start = i;
      while (i < source.length && isWordChar(at(i))) i++;
      push("word", source.slice(start, i));
    } else if (/[0-9]/.test(c)) {
      while (i < source.length && /[\w.]/.test(at(i))) i++;
      push("value", "0");
    } else if (c === "{" || c === "(" || c === "[") {
      const previous = tokens.at(-1);
      openers.push(
        c === "{"
          ? braceOpensBlock()
          : c === "(" && previous?.kind === "word" && CONTROL_HEADERS.has(previous.value),
      );
      push("punct", c);
      depth++;
      i++;
    } else if (c === "}" && templates.at(-1) === depth - 1) {
      templates.pop();
      depth--;
      i++;
      templateText();
    } else if (c === "}" || c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      push("punct", c, openers.pop() ?? false);
      i++;
    } else if (source.startsWith("...", i)) {
      push("punct", "...");
      i += 3;
    } else {
      push("punct", c);
      i++;
    }
  }
  return tokens;
}

/** A new line that starts a statement ends an initializer the cell left without a semicolon. */
const startsStatement = (token: Token, previous: Token | undefined) =>
  token.lineBreakBefore &&
  token.kind === "word" &&
  previous !== undefined &&
  (previous.kind !== "punct" ||
    previous.value === ")" ||
    previous.value === "]" ||
    previous.value === "}");

/** Names a cell declares at its top level, each with whether its binding is constant. */
function declaredBindings(tokens: ReadonlyArray<Token>): ReadonlyMap<string, boolean> {
  const names = new Map<string, boolean>();
  const add = (token: Token | undefined, constant: boolean) => {
    if (
      token?.kind === "word" &&
      NAME.test(token.value) &&
      !RESERVED.has(token.value) &&
      !token.value.startsWith("__") &&
      names.size < MAX_NAMES
    )
      names.set(token.value, constant || names.get(token.value) === true);
  };
  // Ends an initializer: a comma or semicolon at its depth, a statement on a new line, or a close.
  const endsInitializer = (index: number, depth: number) => {
    const token = tokens[index];
    if (token === undefined || token.depth < depth) return true;
    if (token.depth !== depth) return false;
    return token.value === "," || token.value === ";" || startsStatement(token, tokens[index - 1]);
  };
  // A default inside a pattern runs to the next comma or the pattern's close.
  const skipDefault = (start: number, openDepth: number) => {
    let j = start;
    for (let token = tokens[j]; token !== undefined && token.depth > openDepth; token = tokens[++j])
      if (token.depth === openDepth + 1 && token.value === ",") break;
    return j;
  };
  const target = (start: number, constant: boolean): number => {
    const token = tokens[start];
    if (token?.kind === "word") {
      add(token, constant);
      return start + 1;
    }
    if (token?.value === "{" || token?.value === "[") return pattern(start, constant);
    return start + 1;
  };
  // Binds an object or array pattern's targets, never its keys or defaults; returns past its close.
  const pattern = (start: number, constant: boolean): number => {
    const open = tokens[start];
    if (open === undefined) return start + 1;
    let j = start + 1;
    for (let token = tokens[j]; token !== undefined; token = tokens[j]) {
      if (token.depth <= open.depth) return j + 1;
      if (token.value === ",") {
        j++;
        continue;
      }
      if (token.value === "...") j = target(j + 1, constant);
      else if (open.value === "{") {
        if (token.value === "[") {
          j++;
          while (tokens[j] !== undefined && (tokens[j]?.depth ?? 0) > token.depth) j++;
          j++;
        } else j++;
        if (tokens[j]?.value === ":") j = target(j + 1, constant);
        else if (token.kind === "word") add(token, constant);
      } else j = target(j, constant);
      if (tokens[j]?.value === "=") j = skipDefault(j + 1, open.depth);
    }
    return j;
  };
  const declarators = (start: number, depth: number, constant: boolean) => {
    let j = start;
    for (;;) {
      const first = tokens[j];
      if (
        first === undefined ||
        (first.kind !== "word" && first.value !== "{" && first.value !== "[")
      )
        return j;
      j = target(j, constant);
      if (tokens[j]?.value === "=") {
        j++;
        while (!endsInitializer(j, depth)) j++;
      }
      const separator = tokens[j];
      if (separator?.value !== "," || separator.depth !== depth) return j;
      j++;
    }
  };
  for (let k = 0; k < tokens.length && names.size < MAX_NAMES; k++) {
    const token = tokens[k];
    if (token?.kind !== "word" || tokens[k - 1]?.value === ".") continue;
    const next = tokens[k + 1];
    const declares =
      next !== undefined && (next.kind === "word" || next.value === "{" || next.value === "[");
    const topLevel = token.depth === 0;
    if (token.value === "var" || (topLevel && (token.value === "let" || token.value === "const"))) {
      if (declares) k = declarators(k + 1, token.depth, token.value === "const") - 1;
    } else if (topLevel && token.value === "function") {
      add(next?.value === "*" ? tokens[k + 2] : next, false);
    } else if (topLevel && token.value === "class" && next?.value !== "extends") {
      add(next, false);
    }
  }
  return names;
}

/** Names a cell declares at its top level, in source order. */
export function topLevelBindings(source: string): ReadonlyArray<string> {
  return [...declaredBindings(tokenize(source)).keys()];
}

/** The cell as written, as the async function the child calls. */
export const plainCell = (source: string) => `(async () => {\n${source}\n})`;

/**
 * Compiles only when the cell's body is sloppy: QuickJS, not this scanner, reads its directives.
 * Appending an empty statement and a with statement changes nothing else about a valid body.
 */
export const sloppyProbe = (source: string) => `(async () => {\n${source}\n;with({}){}\n})`;

/**
 * Evaluates to [cell, save]: one statement in front of the body hands out the saver, which the
 * child calls once the cell settles. Helper names carry the cell's id and the keeper is captured
 * outside its scope. The statement demotes the cell's directives, so strict restates them.
 */
export function keptCell(source: string, suffix: string, strict: boolean): string {
  const keep = `__k_${suffix}`;
  const save = `__s_${suffix}`;
  const value = `__v_${suffix}`;
  // Every name gets a setter: QuickJS refuses a write to a const, whatever the scanner thought.
  const calls = [...declaredBindings(tokenize(source)).keys()]
    .map((name) => `${keep}(${JSON.stringify(name)},()=>${name},(${value})=>{${name}=${value};});`)
    .join("");
  const directive = strict ? '"use strict";' : "";
  return `(() => {const ${keep}=__screenKeep;let ${save};return [async () => {${directive}${save}=()=>{${calls}};\n${source}\n}, () => { ${save}?.(); }];})()`;
}
